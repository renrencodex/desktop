use std::{
    env,
    io::{self, Read},
    net::SocketAddr,
    pin::Pin,
    process::ExitCode,
    sync::Arc,
    task::{Context, Poll},
    thread,
};

use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc},
    time::{Duration, timeout},
};
use tokio_rustls::{TlsConnector, client::TlsStream};

const ALPN: &[u8] = b"renrencodex-tunnel/1";
const REMOTE_PORT: u16 = 443;
const PREVIEW_SUFFIX: &str = ".preview.renrencodex.com";
const MAX_CONTROL_LINE: usize = 128;
const MAX_FORWARD_CONNECTIONS: usize = 64;
const STDIN_CHANNEL_CAPACITY: usize = 4;
const STDIN_CHUNK_SIZE: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const GATEWAY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Proxy { host: String },
    Forward { host: String, listen: SocketAddr },
    Help,
}

fn usage() -> &'static str {
    "Usage:\n  renrencodex-connect proxy <preview-host>\n  renrencodex-connect forward <preview-host> --listen <127.0.0.1:port|[::1]:port>\n"
}

fn validate_preview_host(value: &str) -> Result<String, String> {
    if !value.is_ascii() {
        return Err("preview host must contain only ASCII characters".into());
    }
    let host = value.to_ascii_lowercase();
    let route = host
        .strip_suffix(PREVIEW_SUFFIX)
        .ok_or_else(|| "preview host must end in .preview.renrencodex.com".to_string())?;
    let (port, machine_id) = route
        .split_once('-')
        .ok_or_else(|| "preview host must start with <port>-<machine-id>".to_string())?;
    if port.parse::<u16>().ok().filter(|port| *port > 0).is_none() {
        return Err("preview host contains an invalid port".into());
    }
    if machine_id.len() != 26
        || !machine_id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'h' | b'j'..=b'k' | b'm'..=b'n' | b'p'..=b't' | b'v'..=b'z'))
    {
        return Err("preview host contains an invalid machine id".into());
    }
    Ok(host)
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        return Ok(Command::Help);
    };
    if command == "--help" || command == "-h" || command == "help" {
        return Ok(Command::Help);
    }
    let host = validate_preview_host(
        &args
            .next()
            .ok_or_else(|| format!("missing preview host\n{}", usage()))?,
    )?;
    match command.as_str() {
        "proxy" => {
            if args.next().is_some() {
                return Err(format!("proxy accepts exactly one host\n{}", usage()));
            }
            Ok(Command::Proxy { host })
        }
        "forward" => {
            if args.next().as_deref() != Some("--listen") {
                return Err(format!("forward requires --listen\n{}", usage()));
            }
            let listen = args
                .next()
                .ok_or_else(|| "missing local listen address".to_string())?
                .parse::<SocketAddr>()
                .map_err(|_| "local listen address must be an IP address and port".to_string())?;
            if !listen.ip().is_loopback() {
                return Err("local forward listener must use 127.0.0.1 or ::1".into());
            }
            if listen.port() == 0 {
                return Err("local forward listener port must be non-zero".into());
            }
            if args.next().is_some() {
                return Err(format!("unexpected forward arguments\n{}", usage()));
            }
            Ok(Command::Forward { host, listen })
        }
        _ => Err(format!("unknown command: {command}\n{}", usage())),
    }
}

fn tls_config() -> Result<Arc<ClientConfig>, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let native = rustls_native_certs::load_native_certs();
    if native.certs.is_empty() {
        return Err(format!(
            "no operating-system trust roots were loaded ({} loader errors)",
            native.errors.len()
        ));
    }
    let mut roots = RootCertStore::empty();
    let mut accepted = 0usize;
    for certificate in native.certs {
        if roots.add(certificate).is_ok() {
            accepted += 1;
        }
    }
    if accepted == 0 {
        return Err("none of the operating-system trust roots were valid".into());
    }
    let mut config = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![ALPN.to_vec()];
    Ok(Arc::new(config))
}

async fn read_control_line(stream: &mut TlsStream<TcpStream>) -> Result<(), String> {
    let mut line = Vec::with_capacity(32);
    while line.len() < MAX_CONTROL_LINE {
        let byte = stream
            .read_u8()
            .await
            .map_err(|error| format!("failed to read gateway response: {error}"))?;
        line.push(byte);
        if line.ends_with(b"\r\n") {
            break;
        }
    }
    if !line.ends_with(b"\r\n") {
        return Err("gateway response exceeded the control-line limit".into());
    }
    let line = std::str::from_utf8(&line)
        .map_err(|_| "gateway returned a non-UTF-8 control line".to_string())?;
    match line {
        "RRCX/1 OK\r\n" => Ok(()),
        value if value.starts_with("RRCX/1 ERR ") => Err(format!(
            "gateway rejected the connection: {}",
            value
                .trim_end_matches("\r\n")
                .strip_prefix("RRCX/1 ERR ")
                .unwrap_or("UNKNOWN")
        )),
        _ => Err("gateway returned an invalid control line".into()),
    }
}

async fn connect(host: &str, config: Arc<ClientConfig>) -> Result<TlsStream<TcpStream>, String> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, REMOTE_PORT)))
        .await
        .map_err(|_| format!("connection to {host}:{REMOTE_PORT} timed out"))?
        .map_err(|error| format!("failed to connect to {host}:{REMOTE_PORT}: {error}"))?;
    tcp.set_nodelay(true)
        .map_err(|error| format!("failed to configure TCP connection: {error}"))?;
    let server_name = ServerName::try_from(host.to_owned())
        .map_err(|_| "preview host is not a valid TLS server name".to_string())?;
    let mut tls = timeout(
        TLS_HANDSHAKE_TIMEOUT,
        TlsConnector::from(config).connect(server_name, tcp),
    )
    .await
    .map_err(|_| format!("TLS handshake with {host} timed out"))?
    .map_err(|error| format!("TLS verification failed for {host}: {error}"))?;
    if tls.get_ref().1.alpn_protocol() != Some(ALPN) {
        return Err("server did not negotiate renrencodex-tunnel/1".into());
    }
    timeout(GATEWAY_RESPONSE_TIMEOUT, read_control_line(&mut tls))
        .await
        .map_err(|_| "gateway response timed out".to_string())??;
    Ok(tls)
}

struct DetachedStdin {
    receiver: mpsc::Receiver<io::Result<Vec<u8>>>,
    buffer: Vec<u8>,
    offset: usize,
}

impl AsyncRead for DetachedStdin {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        let this = self.get_mut();
        loop {
            if this.offset < this.buffer.len() {
                let length = output.remaining().min(this.buffer.len() - this.offset);
                output.put_slice(&this.buffer[this.offset..this.offset + length]);
                this.offset += length;
                if this.offset == this.buffer.len() {
                    this.buffer.clear();
                    this.offset = 0;
                }
                return Poll::Ready(Ok(()));
            }

            match this.receiver.poll_recv(cx) {
                Poll::Ready(Some(Ok(buffer))) if buffer.is_empty() => continue,
                Poll::Ready(Some(Ok(buffer))) => this.buffer = buffer,
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

fn detached_stdin_with_start_hook(
    start_hook: impl FnOnce() + Send + 'static,
) -> io::Result<DetachedStdin> {
    let (sender, receiver) = mpsc::channel(STDIN_CHANNEL_CAPACITY);
    thread::Builder::new()
        .name("renrencodex-connect-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut stdin = stdin.lock();
            start_hook();

            loop {
                let mut buffer = vec![0; STDIN_CHUNK_SIZE];
                match stdin.read(&mut buffer) {
                    Ok(0) => return,
                    Ok(length) => {
                        buffer.truncate(length);
                        if sender.blocking_send(Ok(buffer)).is_err() {
                            return;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = sender.blocking_send(Err(error));
                        return;
                    }
                }
            }
        })?;

    Ok(DetachedStdin {
        receiver,
        buffer: Vec::new(),
        offset: 0,
    })
}

fn detached_stdin() -> io::Result<DetachedStdin> {
    // Tokio implements stdin with an uncancellable runtime blocking task. A detached
    // OS thread lets ProxyCommand exit when the remote closes even if stdin stays open.
    detached_stdin_with_start_hook(|| {})
}

async fn relay_proxy_until_remote_eof<LocalRead, LocalWrite, RemoteRead, RemoteWrite>(
    mut local_reader: LocalRead,
    mut local_writer: LocalWrite,
    mut remote_reader: RemoteRead,
    mut remote_writer: RemoteWrite,
) -> Result<(), String>
where
    LocalRead: AsyncRead + Unpin,
    LocalWrite: AsyncWrite + Unpin,
    RemoteRead: AsyncRead + Unpin,
    RemoteWrite: AsyncWrite + Unpin,
{
    let upload = async {
        tokio::io::copy(&mut local_reader, &mut remote_writer)
            .await
            .map_err(|error| format!("failed to upload proxy data: {error}"))?;
        remote_writer
            .shutdown()
            .await
            .map_err(|error| format!("failed to close proxy upload: {error}"))
    };
    let download = async {
        tokio::io::copy(&mut remote_reader, &mut local_writer)
            .await
            .map_err(|error| format!("failed to download proxy data: {error}"))?;
        local_writer
            .flush()
            .await
            .map_err(|error| format!("failed to flush proxy output: {error}"))
    };
    tokio::pin!(upload, download);
    tokio::select! {
        // SSH 服务端关闭连接时 stdin 往往仍保持打开；以远端 EOF 为会话终点并取消上传。
        result = &mut download => result,
        result = &mut upload => {
            result?;
            download.await
        }
    }
}

async fn proxy(host: String, config: Arc<ClientConfig>) -> Result<(), String> {
    let tls = connect(&host, config).await?;
    let (remote_reader, remote_writer) = tokio::io::split(tls);
    let local_reader =
        detached_stdin().map_err(|error| format!("failed to start proxy stdin reader: {error}"))?;
    relay_proxy_until_remote_eof(
        local_reader,
        tokio::io::stdout(),
        remote_reader,
        remote_writer,
    )
    .await
}

async fn forward_connection(
    mut local: TcpStream,
    host: String,
    config: Arc<ClientConfig>,
) -> Result<(), String> {
    local
        .set_nodelay(true)
        .map_err(|error| format!("failed to configure local connection: {error}"))?;
    let mut remote = connect(&host, config).await?;
    tokio::io::copy_bidirectional(&mut local, &mut remote)
        .await
        .map_err(|error| format!("TCP forwarding failed: {error}"))?;
    Ok(())
}

async fn forward(
    host: String,
    listen: SocketAddr,
    config: Arc<ClientConfig>,
) -> Result<(), String> {
    let listener = TcpListener::bind(listen)
        .await
        .map_err(|error| format!("failed to bind {listen}: {error}"))?;
    let actual = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect local listener: {error}"))?;
    eprintln!("renrencodex-connect forwarding {actual} to {host}:{REMOTE_PORT}");
    let permits = Arc::new(Semaphore::new(MAX_FORWARD_CONNECTIONS));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (local, _) = accepted.map_err(|error| format!("local accept failed: {error}"))?;
                let permit = permits.clone().try_acquire_owned();
                let Ok(permit) = permit else {
                    drop(local);
                    eprintln!("renrencodex-connect rejected a local connection: limit reached");
                    continue;
                };
                let connection_host = host.clone();
                let connection_config = config.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = forward_connection(local, connection_host, connection_config).await {
                        eprintln!("renrencodex-connect: {error}");
                    }
                });
            }
            interrupted = tokio::signal::ctrl_c() => {
                interrupted.map_err(|error| format!("failed to listen for Ctrl-C: {error}"))?;
                return Ok(());
            }
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let command = match parse_args(env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("renrencodex-connect: {error}");
            return ExitCode::from(2);
        }
    };
    if command == Command::Help {
        print!("{}", usage());
        return ExitCode::SUCCESS;
    }
    let config = match tls_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("renrencodex-connect: {error}");
            return ExitCode::FAILURE;
        }
    };
    let result = match command {
        Command::Proxy { host } => proxy(host, config).await,
        Command::Forward { host, listen } => forward(host, listen, config).await,
        Command::Help => unreachable!(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("renrencodex-connect: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command as ProcessCommand, Stdio},
        sync::mpsc::sync_channel,
        time::Instant,
    };

    const HOST: &str = "22-01m7p13gfg7z3zctc387s40yym.preview.renrencodex.com";
    const PROCESS_CHILD_ENV: &str = "RENRENCODEX_CONNECT_REMOTE_EOF_CHILD";
    const PROCESS_PAYLOAD: &[u8] = b"SSH-2.0-renrencodex-process-test\r\n\0\xff";

    #[test]
    fn accepts_exact_preview_host() {
        assert_eq!(
            validate_preview_host(&HOST.to_ascii_uppercase()).unwrap(),
            HOST
        );
    }

    #[test]
    fn rejects_foreign_domains_and_bad_machine_ids() {
        assert!(validate_preview_host("22-example.com").is_err());
        assert!(validate_preview_host("22-short.preview.renrencodex.com").is_err());
    }

    #[test]
    fn forward_requires_a_loopback_listener() {
        let parsed = parse_args([
            "forward".into(),
            HOST.into(),
            "--listen".into(),
            "127.0.0.1:18471".into(),
        ])
        .unwrap();
        assert_eq!(
            parsed,
            Command::Forward {
                host: HOST.into(),
                listen: "127.0.0.1:18471".parse().unwrap(),
            }
        );
        assert!(
            parse_args([
                "forward".into(),
                HOST.into(),
                "--listen".into(),
                "0.0.0.0:18471".into(),
            ])
            .is_err()
        );
    }

    #[tokio::test]
    async fn proxy_finishes_when_remote_closes_while_local_input_stays_open() {
        let (_local_input, local_reader) = tokio::io::duplex(64);
        let (local_writer, _local_output) = tokio::io::duplex(64);
        let (remote_peer, remote_side) = tokio::io::duplex(64);
        let (remote_reader, remote_writer) = tokio::io::split(remote_side);

        // 保持 _local_input 打开，使上传方向持续等待；远端 EOF 仍应终止整个代理。
        drop(remote_peer);
        let result = timeout(
            Duration::from_millis(250),
            relay_proxy_until_remote_eof(local_reader, local_writer, remote_reader, remote_writer),
        )
        .await;
        assert!(result.is_ok(), "proxy stayed blocked after remote EOF");
        assert!(result.unwrap().is_ok());
    }

    #[test]
    fn proxy_process_child_exits_after_remote_eof() {
        if env::var_os(PROCESS_CHILD_ENV).is_none() {
            return;
        }

        let (started_sender, started_receiver) = sync_channel(1);
        let local_reader = detached_stdin_with_start_hook(move || {
            let _ = started_sender.send(());
        })
        .unwrap();
        started_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("stdin reader thread did not start");
        // Give the reader time to enter the blocking OS read while the parent keeps
        // the other end of the stdin pipe open.
        thread::sleep(Duration::from_millis(100));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async move {
            let (mut remote_peer, remote_side) = tokio::io::duplex(64);
            let (remote_reader, remote_writer) = tokio::io::split(remote_side);
            timeout(Duration::from_secs(2), async move {
                let remote = async move {
                    let mut received = vec![0; PROCESS_PAYLOAD.len()];
                    remote_peer.read_exact(&mut received).await.unwrap();
                    assert_eq!(received, PROCESS_PAYLOAD);
                    // Let the stdin thread return to its next blocking read before the
                    // simulated SSH server closes the connection.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    drop(remote_peer);
                };
                let relay = relay_proxy_until_remote_eof(
                    local_reader,
                    tokio::io::sink(),
                    remote_reader,
                    remote_writer,
                );
                let ((), relay_result) = tokio::join!(remote, relay);
                relay_result
            })
            .await
        });
        assert!(result.is_ok(), "proxy stayed blocked after remote EOF");
        assert!(result.unwrap().is_ok());
    }

    #[test]
    fn proxy_process_exits_while_stdin_pipe_remains_open() {
        let mut child = ProcessCommand::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::proxy_process_child_exits_after_remote_eof",
                "--nocapture",
            ])
            .env(PROCESS_CHILD_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to start proxy process test child");
        let mut held_stdin = child.stdin.take().expect("child stdin was not piped");
        held_stdin.write_all(PROCESS_PAYLOAD).unwrap();
        held_stdin.flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);

        let status = loop {
            match child.try_wait().expect("failed to inspect proxy process") {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("proxy process did not exit after remote EOF");
                }
            }
        };
        drop(held_stdin);

        let mut stderr = String::new();
        child
            .stderr
            .take()
            .expect("child stderr was not piped")
            .read_to_string(&mut stderr)
            .unwrap();
        assert!(status.success(), "proxy process child failed: {stderr}");
    }
}
