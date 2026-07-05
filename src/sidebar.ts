// Sidebar tree: goals, context summary, suggestions, and pending approvals.
// Renders cached state only; never rebuilds repo context from a render path.
import * as vscode from "vscode";
import { PendingAction, Suggestion } from "./core/types";
import * as state from "./state";

export type SidebarNode =
  | { kind: "section"; label: string; children: SidebarNode[] }
  | { kind: "info"; label: string; description?: string; tooltip?: string; icon?: string }
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
      item.description = node.description;
      item.tooltip = node.tooltip;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
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
    // Keep the row short so titles survive a narrow sidebar; confidence and
    // action type live in the tooltip.
    item.description = s.action_type === "advice" ? undefined : s.action_type;
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

    // Compact rows: short label, muted description, detail in tooltip.
    // Long goal text truncates in the description instead of forcing a wide sidebar.
    const steering: SidebarNode[] = [
      {
        kind: "info",
        label: "Goal",
        description: state.data.long_term_goal ?? "not set",
        icon: "target",
        tooltip: `${state.data.long_term_goal ?? "none"} (${state.data.long_term_goal_source})\n\nBroad project goal. Set with Master Hand: Set Project Goal.`,
      },
      {
        kind: "info",
        label: "Focus",
        description: state.data.short_term_goal ?? "not set",
        icon: "location",
        tooltip: `${state.data.short_term_goal ?? "none"} (${state.data.short_term_goal_source})\n\nImmediate focus. Set with Master Hand: Set Current Focus.`,
      },
    ];
    if (snap) {
      steering.push({
        kind: "info",
        label: snap.branch || "?",
        description: `${snap.changed_files.length}Δ · ${snap.diagnostics.errors}E ${snap.diagnostics.warnings}W`,
        icon: "git-branch",
        tooltip: `${snap.changed_files.length} changed files · ${snap.diagnostics.errors} errors · ${snap.diagnostics.warnings} warnings`,
      });
    }
    roots.push({ kind: "section", label: "Workspace", children: steering });

    const suggestionNodes: SidebarNode[] = state.data.suggestions.map((s, index) => ({ kind: "suggestion", index, suggestion: s }));
    if (state.data.loading) {
      suggestionNodes.unshift({ kind: "info", label: state.data.loading_message ?? "loading suggestions…", icon: "loading~spin" });
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
