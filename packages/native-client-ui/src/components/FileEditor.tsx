/**
 * Monaco Editor 包装（15 节文件编辑）。
 *
 * - 经 React.lazy 独立 chunk 加载（monaco 体积大，不拖慢首屏；
 *   bun test 模块图也不会触达本文件，与 Terminal/xterm 同一隔离模式）；
 * - worker 使用 Next.js 支持的 `new Worker(new URL(..., import.meta.url))` 打包；
 * - 单个 Monaco Editor 在多个文件 model 间切换，保留各文件的光标与滚动位置；
 * - 父组件关闭标签后释放对应 model；Ctrl/Cmd+S 触发 onSave。
 */
"use client";

// 必须先加载语言包，再加载 Monaco 主模块，确保查找框、菜单等内置界面使用简体中文。
import "monaco-editor/nls/lang/zh-cn";
import * as monaco from "monaco-editor";
import { configureWorkspaceMonacoWorkers } from "@cloud-machine/workspace-ui";
import {
  captureFileScrollPosition,
  resolveFileScrollPosition,
} from "@cloud-machine/workspace-ui/file-scroll-position";
import { useEffect, useLayoutEffect, useRef } from "react";

import { getThemeDefinition, monacoThemeName, THEME_DEFINITIONS } from "../lib/themes";
import { useThemeStore } from "../stores/theme";
import { monoFontFamily, onMonoFontLoaded } from "../lib/fonts";

function monacoForeground(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

function getOrCreateModel(
  machineId: string,
  path: string,
  value: string,
  language: string,
): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme: "cmfs", authority: machineId, path });
  const existing = monaco.editor.getModel(uri);
  if (!existing || existing.isDisposed()) return monaco.editor.createModel(value, language, uri);
  if (existing.getLanguageId() !== language) monaco.editor.setModelLanguage(existing, language);
  if (existing.getValue() !== value) existing.setValue(value);
  return existing;
}

/**
 * editor.dispose() 会取消 occurrence 高亮，但该请求内部还有一段异步收尾。
 * 延后到下一个 task 再销毁未被新 editor 复用的 model，避免其访问已释放
 * TextModelPart；React Strict Mode 立即重挂载时也能复用同 URI model。
 */
function disposeDetachedModelsLater(models: readonly monaco.editor.ITextModel[]): void {
  window.setTimeout(() => {
    const attachedModels = new Set(monaco.editor.getEditors().map((editor) => editor.getModel()));
    for (const model of models) {
      if (!model.isDisposed() && !attachedModels.has(model)) model.dispose();
    }
  }, 0);
}

function ensureMonacoThemes(): void {
  for (const theme of THEME_DEFINITIONS) {
    const themeName = monacoThemeName(theme.id);
    const palette = theme.editor;
    const rules: monaco.editor.ITokenThemeRule[] = [];
    if ("syntax" in palette) {
      const syntax = palette.syntax;
      rules.push(
        { token: "comment", foreground: monacoForeground(syntax.comment) },
        { token: "keyword", foreground: monacoForeground(syntax.keyword) },
        { token: "string", foreground: monacoForeground(syntax.string) },
        { token: "number", foreground: monacoForeground(syntax.number) },
        { token: "function", foreground: monacoForeground(syntax.function) },
        { token: "predefined", foreground: monacoForeground(syntax.function) },
        { token: "type", foreground: monacoForeground(syntax.type) },
        { token: "type.identifier", foreground: monacoForeground(syntax.type) },
        { token: "identifier", foreground: monacoForeground(syntax.variable) },
        { token: "operator", foreground: monacoForeground(syntax.operator) },
        { token: "delimiter", foreground: monacoForeground(syntax.operator) },
      );
    }
    monaco.editor.defineTheme(themeName, {
      base: "vs-dark",
      inherit: true,
      rules,
      colors: {
        "editor.background": palette.background,
        "editor.foreground": palette.foreground,
        "editor.lineHighlightBackground": palette.lineHighlight,
        "editorLineNumber.foreground": palette.lineNumber,
        "editorLineNumber.activeForeground": palette.activeLineNumber,
        "editorCursor.foreground": palette.cursor,
        "editor.selectionBackground": palette.selection,
        "editorWidget.background": palette.widgetBackground,
        "editorWidget.border": palette.widgetBorder,
        "editorGutter.background": palette.gutterBackground,
      },
    });
  }
}

configureWorkspaceMonacoWorkers();

export interface FileEditorProps {
  searchReveal?: import("@cloud-machine/workspace-ui/file-search").FileSearchReveal | null;
  onSearchRevealFailure?: () => void;
  onSearchRevealHandled?: () => void;
  machineId: string;
  active?: boolean;
  ownerId?: string;
  path: string;
  value: string;
  language: string;
  openFiles: ReadonlyArray<{ path: string; value: string; language: string }>;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}

export function FileEditor(props: FileEditorProps) {
  const active = props.active ?? true;
  const modelOwner = `${props.machineId}:${props.ownerId ?? "default"}`;
  const activeRef = useRef(active);
  const themeId = useThemeStore((theme) => theme.themeId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const handledSearchReveal = useRef<number | null>(null);
  const refreshFontRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (active) {
      refreshFontRef.current?.();
      editorRef.current?.layout();
    }
  }, [active]);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const activePathRef = useRef(props.path);
  // 回调经 ref 转发，避免 mount-once effect 捕获过期闭包。
  const callbacksRef = useRef({ onChange: props.onChange, onSave: props.onSave });
  useEffect(() => {
    callbacksRef.current = { onChange: props.onChange, onSave: props.onSave };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureMonacoThemes();
    const models = modelsRef.current;
    const viewStates = viewStatesRef.current;

    const model = getOrCreateModel(modelOwner, props.path, props.value, props.language);
    models.set(props.path, model);
    const editor = monaco.editor.create(container, {
      model,
      theme: monacoThemeName(useThemeStore.getState().themeId),
      automaticLayout: false,
      minimap: { enabled: false },
      fontSize: 12,
      fontFamily: monoFontFamily(container),
      renderValidationDecorations: "off",
      scrollbar: {
        verticalScrollbarSize: 7,
        horizontalScrollbarSize: 6,
      },
      scrollBeyondLastLine: false,
      readOnly: props.readOnly,
    });
    editorRef.current = editor;
    let fontPending = false;
    const refreshFont = () => {
      if (!fontPending || !activeRef.current || !container.clientWidth || !container.clientHeight)
        return;
      fontPending = false;
      monaco.editor.remeasureFonts();
      editor.layout();
    };
    refreshFontRef.current = refreshFont;
    const stopFontListener = onMonoFontLoaded(container, 12, () => {
      fontPending = true;
      refreshFont();
    });
    const observer = new ResizeObserver(() => {
      refreshFont();
      if (activeRef.current) editor.layout();
    });
    observer.observe(container);
    const sub = editor.onDidChangeModelContent(() => {
      callbacksRef.current.onChange(editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      callbacksRef.current.onSave();
    });
    return () => {
      stopFontListener();
      refreshFontRef.current = null;
      observer.disconnect();
      sub.dispose();
      // 先停止高亮并从 model 脱离，再销毁 editor；避免 Monaco 异步
      // occurrence 请求在 model.dispose() 之后继续读取 TextModelPart。
      editor.updateOptions({ occurrencesHighlight: "off" });
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      const detachedModels = [...models.values()];
      models.clear();
      viewStates.clear();
      disposeDetachedModelsLater(detachedModels);
    };
    // Initial model is created once; file switching is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const previousPath = activePathRef.current;
    const sameFileViewState = previousPath === props.path ? editor.saveViewState() : null;
    const sameFileScrollPosition =
      previousPath === props.path
        ? captureFileScrollPosition({
            scrollTop: editor.getScrollTop(),
            scrollLeft: editor.getScrollLeft(),
            scrollHeight: editor.getScrollHeight(),
            clientHeight: editor.getLayoutInfo().height,
          })
        : null;
    if (previousPath !== props.path) {
      const viewState = editor.saveViewState();
      if (viewState) viewStatesRef.current.set(previousPath, viewState);
    }

    let model = modelsRef.current.get(props.path);
    if (!model) {
      model = getOrCreateModel(modelOwner, props.path, props.value, props.language);
      modelsRef.current.set(props.path, model);
    } else if (model.getLanguageId() !== props.language) {
      monaco.editor.setModelLanguage(model, props.language);
    }
    if (model.getValue() !== props.value) model.setValue(props.value);
    if (editor.getModel() !== model) editor.setModel(model);
    const viewState = viewStatesRef.current.get(props.path);
    if (previousPath !== props.path && viewState) editor.restoreViewState(viewState);
    else if (sameFileViewState) editor.restoreViewState(sameFileViewState);
    if (sameFileScrollPosition) {
      const restored = resolveFileScrollPosition(sameFileScrollPosition, {
        scrollHeight: editor.getScrollHeight(),
        clientHeight: editor.getLayoutInfo().height,
      });
      editor.setScrollPosition(
        { scrollTop: restored.top, scrollLeft: restored.left },
        monaco.editor.ScrollType.Immediate,
      );
    }
    activePathRef.current = props.path;
    if (activeRef.current) editor.focus();
  }, [modelOwner, props.language, props.machineId, props.path, props.value]);

  useEffect(() => {
    const request = props.searchReveal;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (
      !active ||
      !request ||
      request.path !== props.path ||
      request.id === handledSearchReveal.current ||
      !editor ||
      !model
    )
      return;
    handledSearchReveal.current = request.id;
    props.onSearchRevealHandled?.();
    const range = new monaco.Range(
      request.match.line,
      request.match.column,
      request.match.line,
      request.match.endColumn,
    );
    const valid = model.validateRange(range);
    const expected = request.match.preview.slice(
      request.match.column - request.match.previewColumn,
      request.match.endColumn - request.match.previewColumn,
    );
    if (!valid.equalsRange(range) || model.getValueInRange(range) !== expected) {
      props.onSearchRevealFailure?.();
      return;
    }
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
  }, [active, props]);

  useEffect(() => {
    const openPaths = new Set(props.openFiles.map((file) => file.path));
    for (const [path, model] of modelsRef.current) {
      if (!openPaths.has(path)) {
        model.dispose();
        modelsRef.current.delete(path);
        viewStatesRef.current.delete(path);
      }
    }
  }, [props.openFiles]);

  useLayoutEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly });
  }, [props.readOnly]);

  useLayoutEffect(() => {
    monaco.editor.setTheme(monacoThemeName(themeId));
  }, [themeId]);

  const palette = getThemeDefinition(themeId).editor;
  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: palette.background, colorScheme: palette.colorScheme }}
    />
  );
}
