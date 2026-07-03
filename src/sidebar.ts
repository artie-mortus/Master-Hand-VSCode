// Sidebar tree: goals, context summary, suggestions, and pending approvals.
// Renders cached state only; never rebuilds repo context from a render path.
import * as vscode from "vscode";
import { PendingAction, Suggestion } from "./core/types";
import * as state from "./state";

export type SidebarNode =
  | { kind: "section"; label: string; children: SidebarNode[] }
  | { kind: "info"; label: string; tooltip?: string }
  | { kind: "suggestion"; index: number; suggestion: Suggestion }
  | { kind: "pending"; action: PendingAction };

export class SidebarProvider implements vscode.TreeDataProvider<SidebarNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    if (node.kind === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "section";
      return item;
    }
    if (node.kind === "info") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (node.kind === "pending") {
      const item = new vscode.TreeItem(node.action.title, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "pendingAction";
      item.description = node.action.kind;
      item.iconPath = new vscode.ThemeIcon("shield");
      item.tooltip = node.action.argv ? node.action.argv.join(" ") : node.action.diff?.slice(0, 2000);
      item.command = { command: "masterHand.viewPendingAction", title: "Open", arguments: [node] };
      return item;
    }
    const s = node.suggestion;
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "suggestion";
    item.description = `${Math.round(s.confidence * 100)}% · ${s.action_type}`;
    item.iconPath = new vscode.ThemeIcon(s.action_type === "advice" ? "lightbulb" : "shield");
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${s.title}**\n\n${s.reason}\n\n`);
    if (s.files.length > 0) md.appendMarkdown(`Files: ${s.files.join(", ")}\n\n`);
    if (s.next_action) md.appendMarkdown(`Next: ${s.next_action}\n\n`);
    md.appendMarkdown(`_confidence ${s.confidence.toFixed(2)} · ${s.action_type}_`);
    item.tooltip = md;
    item.command = { command: "masterHand.viewSuggestion", title: "View Details", arguments: [node] };
    return item;
  }

  getChildren(node?: SidebarNode): SidebarNode[] {
    if (node) return node.kind === "section" ? node.children : [];

    // Fresh session with nothing to show: return empty so the viewsWelcome
    // content (buttons for refresh/goal/settings) renders instead.
    if (!state.data.last_context && !state.data.loading && state.data.suggestions.length === 0 && state.pendingActions().length === 0) {
      return [];
    }

    const roots: SidebarNode[] = [];
    const snap = state.data.last_context;

    const steering: SidebarNode[] = [
      {
        kind: "info",
        label: `Project goal: ${state.data.long_term_goal ?? "none"} (${state.data.long_term_goal_source})`,
        tooltip: "Broad project goal. Set with Master Hand: Set Project Goal.",
      },
      {
        kind: "info",
        label: `Current focus: ${state.data.short_term_goal ?? "none"} (${state.data.short_term_goal_source})`,
        tooltip: "Immediate focus. Set with Master Hand: Set Current Focus.",
      },
    ];
    if (snap) {
      steering.push({
        kind: "info",
        label: `${snap.branch || "?"} · ${snap.changed_files.length} changed · ${snap.diagnostics.errors} errors / ${snap.diagnostics.warnings} warnings`,
      });
    }
    roots.push({ kind: "section", label: "Workspace", children: steering });

    const suggestionNodes: SidebarNode[] = state.data.suggestions.map((s, index) => ({ kind: "suggestion", index, suggestion: s }));
    if (state.data.loading) {
      suggestionNodes.unshift({ kind: "info", label: state.data.loading_message ?? "loading suggestions…" });
    }
    if (suggestionNodes.length === 0) {
      suggestionNodes.push({ kind: "info", label: "No suggestions yet — run Master Hand: Refresh Suggestions" });
    }
    roots.push({ kind: "section", label: "Suggestions", children: suggestionNodes });

    const pending = state.pendingActions();
    if (pending.length > 0) {
      roots.push({
        kind: "section",
        label: `Pending approvals (${pending.length})`,
        children: pending.map((action) => ({ kind: "pending", action })),
      });
    }
    return roots;
  }
}
