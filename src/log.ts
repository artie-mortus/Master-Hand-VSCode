// Shared LogOutputChannel: timestamps + levels, user-controllable via the
// output panel's log-level picker. Never used for user-facing notifications.
import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function init(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel("Master Hand", { log: true });
  ctx.subscriptions.push(channel);
}

export function show(): void {
  channel?.show(true);
}

export function info(message: string): void {
  channel?.info(message);
}

export function warn(message: string): void {
  channel?.warn(message);
}

export function error(message: string): void {
  channel?.error(message);
}
