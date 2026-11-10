import { createServer } from 'node:http';
export async function startOAuthCallback(state, port, signal) {
    signal.throwIfAborted();
    const result = Promise.withResolvers();
    void result.promise.catch(() => { });
    let settled = false;
    let timer;
    const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        server.close();
    };
    const fail = (error) => {
        if (settled)
            return;
        settled = true;
        cleanup();
        result.reject(error);
    };
    const abort = () => fail(new Error('Figma authorization cancelled.'));
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/callback') {
            response.writeHead(404).end();
            return;
        }
        if (url.searchParams.get('state') !== state) {
            response.writeHead(400).end('Invalid authorization state.');
            return;
        }
        if (url.searchParams.has('error')) {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization denied. You can close this tab.');
            fail(new Error('Figma authorization denied.'));
            return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
            response.writeHead(400).end('Missing authorization code.');
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization callback received. Return to OMP Desktop to finish.');
        settled = true;
        cleanup();
        result.resolve({ code, state });
    });
    const ready = Promise.withResolvers();
    const failed = (error) => { server.close(); ready.reject(error); };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', failed); ready.resolve(); });
    await ready.promise;
    server.on('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail(new Error('Figma authorization timed out after 120 seconds.')), 120_000);
    timer.unref();
    if (signal.aborted)
        abort();
    return { code: result.promise, port: server.address()?.port ?? port, close: abort };
}
