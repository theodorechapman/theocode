import { initConnections } from "./connections";
import { initWorkspace, refreshWorkspace } from "./workspace";

const workspaceView = document.getElementById("view-workspace")!;
const connectionsView = document.getElementById("view-connections")!;

function showWorkspace(): void {
  connectionsView.hidden = true;
  workspaceView.hidden = false;
  void refreshWorkspace();
}

function showConnections(): void {
  workspaceView.hidden = true;
  connectionsView.hidden = false;
}

document
  .getElementById("nav-connections")!
  .addEventListener("click", showConnections);

void initWorkspace(workspaceView);
void initConnections(connectionsView, showWorkspace);
