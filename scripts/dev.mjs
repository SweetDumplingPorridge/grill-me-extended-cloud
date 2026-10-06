import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['server/dist/http.mjs'], { stdio: 'inherit', env: { ...process.env, LOCAL_DEV: 'true', PUBLIC_URL: `http://127.0.0.1:${process.env.PORT ?? 3000}` } });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
