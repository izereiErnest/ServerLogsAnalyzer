ServerLogsAnalyzer
..........................................................................

A TypeScript CLI tool for parsing and analyzing server logs.

-- Quick start

1. Install dependencies:

npm install

2. Build the project:

npm run build

3. Run the analyzer on a log file:

node dist/analyze.js report path/to/your/logfile.log

-- Optional: generate sample logs for testing

npx ts-node Scripts/GenerateLogs.ts --lines 5000 --output test_logs/sample.log

-- Example commands


npx ts-node src/analyze.ts report test_logs/sample.log
npx ts-node src/analyze.ts slow test_logs/sample.log --n 20
npx ts-node src/analyze.ts errors test_logs/sample.log --n 50
npx ts-node src/analyze.ts ip test_logs/sample.log 192.168.1.42
npx ts-node src/analyze.ts path test_logs/sample.log /api/users
npx ts-node src/analyze.ts status test_logs/sample.log 500
npx ts-node src/analyze.ts info test_logs/sample.log


-- Run tests

npm test