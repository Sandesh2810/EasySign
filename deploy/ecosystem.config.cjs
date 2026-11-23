// PM2 processes for YouNMeSign on the server. Only these two names exist: easysign-web and easysign-worker.
// Run as the Linux user "easysign" with its own PM2_HOME; nothing here touches any other app on the server.
// Settings come from files only that user can read (never from this file): shared/web.env and shared/worker.env.
const home = process.env.EASYSIGN_HOME || '/home/easysign';
const port = process.env.EASYSIGN_PORT || '3210';

module.exports = {
  apps: [
    {
      name: 'easysign-web',
      cwd: `${home}/current`,
      script: 'node_modules/next/dist/bin/next',
      args: `start -H 127.0.0.1 -p ${port}`, // reachable only through the reverse proxy
      interpreter_args: `--env-file=${home}/shared/web.env`,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '450M',
      kill_timeout: 10000,
      autorestart: true,
    },
    {
      name: 'easysign-worker',
      cwd: `${home}/current`,
      script: 'dist/worker.mjs',
      interpreter_args: `--env-file=${home}/shared/worker.env --max-old-space-size=256`,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '350M',
      kill_timeout: 30000, // lets a seal in progress finish
      autorestart: true,
    },
  ],
};
