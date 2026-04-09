const { exec } = require('child_process');
const fs = require('fs');

const ERROR_LOG = 'errors.log';

console.log('🚀 Monitoring Railway deployment logs...');
console.log('Press Ctrl+C to stop\n');

// Clear previous error log
fs.writeFileSync(ERROR_LOG, `--- Error log started ${new Date().toISOString()} ---\n`);

const logs = exec('railway logs -n 200', { maxBuffer: 10 * 1024 * 1024 });
let errorCount = 0;

logs.stdout.on('data', (data) => {
  const text = data.toString();
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    const isError = /\[ERRO\]|ERROR|SyntaxError|TypeError|ReferenceError|Cannot find module|does not exist|SIGTERM|migration failed|500 /i.test(line);
    const isWarn = /\[WARN\]|WARN|deprecated/i.test(line);
    
    if (isError) {
      errorCount++;
      const short = line.length > 200 ? line.substring(0, 200) + '...' : line;
      console.log(`\x1b[31m❌ ${short}\x1b[0m`);
      fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${line}\n`);
    } else if (isWarn) {
      const short = line.length > 150 ? line.substring(0, 150) + '...' : line;
      console.log(`\x1b[33m⚠️  ${short}\x1b[0m`);
    } else if (/Scheduled jobs initialized|Server listening|Migration|crons initialized/i.test(line)) {
      console.log(`\x1b[32m✅ ${line.substring(0, 150)}\x1b[0m`);
    }
  }
});

logs.stderr.on('data', (data) => {
  console.log(`\x1b[33m${data.toString().trim()}\x1b[0m`);
});

logs.on('close', () => {
  console.log(`\n📊 Session complete: ${errorCount} errors captured`);
  if (errorCount > 0) {
    console.log(`📋 Full error log: ${ERROR_LOG}`);
  }
});

process.on('SIGINT', () => {
  console.log(`\n\n📊 Monitoring stopped: ${errorCount} errors captured`);
  if (errorCount > 0) {
    console.log(`📋 Error log saved to: ${ERROR_LOG}`);
  }
  process.exit(0);
});
