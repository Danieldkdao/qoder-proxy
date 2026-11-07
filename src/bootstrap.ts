import { createInterface } from "node:readline";
import { validateContainerEnvironment } from "./runtime-env";
async function main(): Promise<void> {
  const line = await new Promise<string>((resolve, reject) => {
    const reader = createInterface({ input: process.stdin, terminal: false });
    const timer = setTimeout(() => {
      reader.close();
      reject(Error("Runtime environment not supplied"));
    }, 10000);
    let bytes = 0;
    const count = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        reader.close();
        reject(Error("Runtime environment too large"));
      }
    };
    process.stdin.on("data", count);
    reader.once("line", (value) => {
      clearTimeout(timer);
      process.stdin.removeListener("data", count);
      resolve(value);
      reader.close();
      process.stdin.pause();
    });
    reader.once("close", () => {
      clearTimeout(timer);
      process.stdin.removeListener("data", count);
      reject(Error("Runtime environment not supplied"));
    });
    reader.once("error", () => {
      clearTimeout(timer);
      reject(Error("Invalid runtime environment"));
    });
  });
  if (Buffer.byteLength(line, "utf8") > 65536)
    throw Error("Runtime environment too large");
  const environment = validateContainerEnvironment(JSON.parse(line));
  for (const [key, value] of Object.entries(environment))
    process.env[key] = value;
  // Import only after injection: config reads the environment at module load.
  const { startServer } = await import("./server.js");
  startServer();
}
void main().catch(() => {
  console.error(
    "Secure bootstrap failed: supply a valid runtime environment through stdin.",
  );
  process.exit(1);
});
