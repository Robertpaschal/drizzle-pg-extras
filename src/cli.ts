import { pathToFileURL } from "node:url";
import { pendingStatements, generate } from "./generate.js";
import { PgExtrasError } from "./errors.js";
import { loadProject } from "./load.js";

type CliOptions = {
  config?: string;
  name?: string;
  help?: boolean;
};

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }
  let options: CliOptions;
  try {
    options = parseArgs(rest);
  } catch (error) {
    return fail(error);
  }
  if (options.help) {
    printHelp();
    return 0;
  }
  try {
    if (command === "generate") return await generateCommand(options);
    if (command === "check") return await checkCommand(options);
    console.error(`Unknown command "${command}".`);
    printHelp();
    return 1;
  } catch (error) {
    return fail(error);
  }
}

async function generateCommand(options: CliOptions): Promise<number> {
  const project = await loadProject(process.cwd(), options.config);
  const result = generate({
    extras: project.extras,
    out: project.out,
    name: options.name ?? "pg_extras",
    casing: project.casing,
    prefix: project.prefix,
    breakpoints: project.breakpoints,
  });
  if (!result.written) {
    console.log("No changes, nothing to migrate");
    return 0;
  }
  console.log(result.sqlPath);
  console.log(result.downPath);
  return 0;
}

async function checkCommand(options: CliOptions): Promise<number> {
  const project = await loadProject(process.cwd(), options.config);
  const pending = pendingStatements(project.extras, project.out, project.casing);
  if (pending.length === 0) {
    console.log("pg extras are up to date");
    return 0;
  }
  console.error("Definitions changed and have no migration yet:");
  console.error(pending.join("\n\n"));
  return 1;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") {
      const value = args[++i];
      if (!value) throw new PgExtrasError(`${arg} needs a file path`);
      options.config = value;
      continue;
    }
    if (arg === "--name") {
      const value = args[++i];
      if (!value) throw new PgExtrasError("--name needs a migration name");
      options.name = value;
      continue;
    }
    throw new PgExtrasError(`Unknown option ${arg}`);
  }
  return options;
}

function fail(error: unknown): number {
  if (error instanceof PgExtrasError) {
    console.error(error.message);
    return 1;
  }
  console.error(error);
  return 1;
}

function printHelp(): void {
  console.log(`drizzle-pg-extras ${commandList()}

  generate   Write a drizzle-kit migration for functions, triggers, comments, extensions, partitions, and hypertables that changed
  check      Exit 1 when those definitions changed and no migration was written

  --config, -c <file>   drizzle config. Defaults to drizzle.config.ts
  --name <name>         migration name. Defaults to pg_extras
`);
}

function commandList(): string {
  return "generate | check";
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
