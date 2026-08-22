const MAX_LINES = 300;
const buffer = [];

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);

function stringifyArg(a) {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch (err) {
    return String(a);
  }
}

function push(level, args) {
  const line = args.map(stringifyArg).join(' ');
  buffer.push({ level, line, timestamp: new Date().toISOString() });
  if (buffer.length > MAX_LINES) buffer.shift();
}

// Wrap console.log/console.error so every existing log call in the app
// gets captured automatically — Railway's log tab still gets everything
// too, this just also mirrors it into memory for the API to serve.
console.log = (...args) => {
  push('log', args);
  originalLog(...args);
};

console.error = (...args) => {
  push('error', args);
  originalError(...args);
};

export function getRecentLogs(limit = 200) {
  return buffer.slice(-limit).reverse(); // newest first, matching the journal's convention
}
