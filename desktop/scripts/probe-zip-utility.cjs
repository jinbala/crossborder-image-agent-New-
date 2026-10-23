const { app, utilityProcess } = require('electron');
const path = require('node:path');
app.setPath('userData', require('node:fs').mkdtempSync(path.join(__dirname, '../.smoke-data/zip-utility-shell-')));
app.whenReady().then(() => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = utilityProcess.fork(path.join(__dirname, 'probe-zip-lock.mjs'), [], { env, stdio: 'pipe', serviceName: 'Owned ZIP diagnostic' });
  child.stdout?.on('data', data => process.stdout.write(data));
  child.stderr?.on('data', data => process.stderr.write(data));
  const timer = setTimeout(() => { child.kill(); app.exit(1); }, 45000);
  child.once('exit', code => { clearTimeout(timer); app.exit(code ?? 1); });
}).catch(error => { console.error(error); app.exit(1); });
