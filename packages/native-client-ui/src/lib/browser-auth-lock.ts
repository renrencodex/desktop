const AUTH_LOCK_NAME = "renrencodex:auth-cookie";
const AUTH_LOCK_DATABASE = "renrencodex-auth-lock";
const AUTH_LOCK_STORE = "mutex";

/** 同源页面共享 Cookie，但不共享内存中的刷新 Promise。 */
export async function withBrowserAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof window === "undefined") return operation();
  if (navigator.locks?.request) return navigator.locks.request(AUTH_LOCK_NAME, operation);
  // HTTP 局域网开发及旧 WebView 使用 IndexedDB；绝不使用不具备原子性的 storage 租约。
  return withIndexedDbAuthLock(operation);
}

function withIndexedDbAuthLock<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const unavailable = () => new Error("无法安全协调登录请求，请允许网站存储或更新浏览器");
    if (typeof indexedDB === "undefined") {
      reject(unavailable());
      return;
    }
    const request = indexedDB.open(AUTH_LOCK_DATABASE, 1);
    let cancelled = false;
    request.onerror = () => {
      cancelled = true;
      reject(request.error ?? unavailable());
    };
    request.onblocked = () => {
      cancelled = true;
      reject(unavailable());
    };
    request.onupgradeneeded = () => request.result.createObjectStore(AUTH_LOCK_STORE);
    request.onsuccess = () => {
      const database = request.result;
      if (cancelled) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(AUTH_LOCK_STORE, "readwrite");
      } catch (error) {
        database.close();
        reject(error);
        return;
      }
      let started = false;
      let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? unavailable());
      };
      transaction.oncomplete = () => {
        database.close();
        if (!result) reject(unavailable());
        else if (result.ok) resolve(result.value);
        else reject(result.error);
      };
      const store = transaction.objectStore(AUTH_LOCK_STORE);
      // 首个读取成功才代表独占事务已获准运行。网络等待期间始终排队一个读取，
      // 避免事务自动提交；不向数据库写入任何 Token、用户信息或租约。
      const keepAlive = () => {
        const read = store.get(AUTH_LOCK_NAME);
        read.onsuccess = () => {
          if (!started) {
            started = true;
            void Promise.resolve()
              .then(operation)
              .then(
                (value) => {
                  result = { ok: true, value };
                },
                (error: unknown) => {
                  result = { ok: false, error };
                },
              );
          }
          if (!result) keepAlive();
        };
      };
      keepAlive();
    };
  });
}
