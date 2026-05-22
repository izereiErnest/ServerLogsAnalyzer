Project Answers
..................................................................................

1. How to run

-- Install dependencies

npm install

-- Build the project

npm run build

-- Run the analyzer

node dist/analyze.js report path/to/your/logfile.log

-- Generate a sample test log

npx ts-node Scripts/GenerateLogs.ts --lines 5000 --output test_logs/sample.log

-- Run tests


npm test


2. Stack choice

-- Chosen stack

- Node.js
- TypeScript
- Jest
- ts-node for development

-- Why this stack

- The project is a file-based CLI log analyzer, so Node.js is a good fit for file I/O and command-line scripting.
- TypeScript provides type safety for structured parser output and helps avoid parser bugs.
- Jest is a straightforward choice for test coverage in a small TypeScript project.

-- Worse choice

- A browser UI framework like React or Angular would be overkill for a CLI tool.
- Python is listed here as a worse choice not because it is weak, but because I tried to use it and discovered I did not yet have enough skills with it for this project, so I ended up choosing TypeScript instead.


3. One real edge case

-- Edge case handled correctly
- File: `src/Parser.ts`
- Lines: 213-219

const { date } = parseTimeStamp(String(v));
if (date === null && typeof v === "number" && v > 1e9) {
    entry.timestamp = new Date(v * 1000);
} else {
    entry.timestamp = date;
}

-- What it handles

This code allows the JSON parser to accept numeric Unix epoch timestamps in seconds, such as `1690000000`, and convert them correctly to a JavaScript `Date`.

-- What would happen without it

Without this handling, numeric epoch timestamps would leave `timestamp` as `null`, so time-based summaries, sorting, and report ranges would be incomplete for those log entries.


4. AI usage

- I used the GitHub Copilot chat assistant in VS Code to inspect repository files and interpret the implementation.
- After reviewing the `src` folder and the CLI flow, I asked the AI(Claude) to generate the standalone `Scripts/GenerateLogs.ts` file to produce 5000 log lines for testing.
- I also used the AI to help confirm the exact command structure and to phrase the documentation clearly.

-- What I changed from AI output

- I verified exact line numbers directly from the project files and adjusted the answer content to match the repository precisely.
- I also corrected the wording around AI usage so the documentation reflects the real project workflow.


5. Honest gap

-- What isn’t good enough

- The submission lacks a complete understanding of server logs and relies on AI guidance for the parser design and project structure.

-- What I would fix with another day

- Improve the log format documentation and add more parser tests for edge cases such as mixed timestamp formats, malformed JSON, and non-standard log fields.
- Add a richer `README.md with examples of supported log formats, sample output, and a clearer troubleshooting section.
