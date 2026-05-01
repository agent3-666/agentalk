#!/usr/bin/env node
import chalk from "chalk";
import {
  projectKeyFromPath,
  fuzzyMatchProject,
  readMessages,
  writeMessage,
  markAllRead,
  clearMessages,
  listProjects,
} from "../lib/inbox.js";

const argv = process.argv.slice(2);
const subcmd = argv[0];

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function die(msg) {
  console.error(chalk.red(`Error: ${msg}`));
  process.exit(1);
}

function printUsage() {
  console.log(`
Usage: agentalk-inbox <command> [args]

Commands:
  send <project>[/<agent>] <message>   Send a message to a project inbox
  list [<project>[/<agent>]]           List unread messages (default: current project)
  read [<project>[/<agent>]]           Show all messages and mark as read
  clear [<project>[/<agent>]]          Clear messages
  projects                             List all projects with unread messages

Examples:
  agentalk-inbox send arsenal "Please review the auth flow"
  agentalk-inbox send arsenal/codex "Hey Codex, check the rate limiter"
  agentalk-inbox list
  agentalk-inbox projects
`);
}

function parseTarget(raw) {
  if (!raw) return { projectKey: projectKeyFromPath(process.cwd()), agent: null };
  const [projectPart, agent] = raw.includes("/") ? raw.split("/") : [raw, null];
  const key = fuzzyMatchProject(projectPart);
  if (!key) die(`Project not found matching "${projectPart}". Run 'agentalk-inbox projects' to see available projects.`);
  return { projectKey: key, agent: agent || null };
}

if (subcmd === "send") {
  const target = argv[1];
  const message = argv.slice(2).join(" ");
  if (!target || !message) die("Usage: agentalk-inbox send <project>[/<agent>] <message>");

  const [projectPart, agent] = target.includes("/") ? target.split("/") : [target, null];

  // For send, allow new projects (don't require existing)
  let projectKey = fuzzyMatchProject(projectPart);
  if (!projectKey) {
    // Try to find by exact path segment match or create new
    projectKey = projectPart.replace(/\//g, "-");
    console.log(chalk.dim(`Creating new inbox for project: ${projectKey}`));
  }

  const from = `${projectKeyFromPath(process.cwd())}`;
  writeMessage(projectKey, agent || null, { from, content: message });
  const target_label = agent ? `${projectKey}/${agent}` : projectKey;
  console.log(chalk.green(`✓ Message sent to ${target_label}`));

} else if (subcmd === "list" || subcmd === "read") {
  const { projectKey, agent } = argv[1] ? parseTarget(argv[1]) : {
    projectKey: projectKeyFromPath(process.cwd()),
    agent: null,
  };

  const messages = readMessages(projectKey, agent);
  const unread = messages.filter(m => !m.read);
  const show = subcmd === "read" ? messages : unread;

  if (show.length === 0) {
    console.log(chalk.dim("No " + (subcmd === "list" ? "unread " : "") + "messages."));
  } else {
    console.log(chalk.bold(`\n  Inbox: ${projectKey}${agent ? "/" + agent : ""}\n`));
    for (const m of show) {
      const badge = m.read ? chalk.dim("·") : chalk.yellow("●");
      console.log(`  ${badge} ${chalk.dim(formatTime(m.timestamp))}  from: ${chalk.cyan(m.from)}`);
      console.log(`    ${m.content}\n`);
    }
  }

  if (subcmd === "read") markAllRead(projectKey, agent);

} else if (subcmd === "clear") {
  const { projectKey, agent } = argv[1] ? parseTarget(argv[1]) : {
    projectKey: projectKeyFromPath(process.cwd()),
    agent: null,
  };
  clearMessages(projectKey, agent);
  console.log(chalk.green("✓ Inbox cleared."));

} else if (subcmd === "projects") {
  const entries = listProjects();
  if (entries.length === 0) {
    console.log(chalk.dim("No unread messages in any project."));
  } else {
    console.log(chalk.bold("\n  Projects with unread messages:\n"));
    for (const e of entries) {
      const label = e.agent ? `${e.project}/${e.agent}` : `${e.project}  ${chalk.dim("(all agents)")}`;
      console.log(`  ${chalk.yellow("●")} ${label}  ${chalk.dim(e.count + " unread")}`);
    }
    console.log();
  }

} else {
  printUsage();
  process.exit(subcmd ? 1 : 0);
}
