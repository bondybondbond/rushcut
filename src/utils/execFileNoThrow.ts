import { execFile } from "child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execFileNoThrow(
  command: string,
  args: string[]
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // ExecFileException has exitCode (number | null) for the process exit status
        // and code (string | number | null) which may be a POSIX error or signal
        const rawErr = err as unknown as Record<string, unknown>;
        const exitCode =
          typeof rawErr["exitCode"] === "number" ? rawErr["exitCode"] : 1;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? err.message,
          code: exitCode,
        });
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
  });
}
