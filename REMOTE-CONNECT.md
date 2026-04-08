# Connecting to the Agent UI Remotely via Tailscale

The host machine (`100.65.151.32`) is on a **Tailscale** VPN mesh. Any device in the same
Tailscale network can access the Copilot Agent UI directly — no SSH tunnel or firewall changes
needed. Tailscale handles the secure encrypted connection automatically.

---

## Prerequisites on your PC

1. **Tailscale** installed and logged into the **same account/network** as the host
   → https://tailscale.com/download
2. A modern browser (Chrome, Edge, Firefox)

That's it. No Docker, Node.js, or port forwarding needed to *use* the UI.

---

## Connecting

1. Make sure Tailscale is running on your PC and you're logged in.
2. Open your browser and go to:
   ```
   http://100.65.151.32:3000
   ```
3. The Copilot Agent UI loads. It's connected to Docker on the host machine.

> **Verify Tailscale connectivity:** Run `ping 100.65.151.32` — if it responds, port 3000 is accessible.

---

## Using the UI

### View a running container
1. Click **↻** next to "Containers" — active agent containers appear in the dropdown.
2. Select one — live logs stream into the terminal panel on the right.
3. Use **⏹ Cancel** (graceful stop + report) or **💀 Abort** (force kill).

### Start a new agent session
1. **Project Path** — enter the path *on the host machine*, e.g. `D:\Code\CFT\office-app`
2. **Agent** — pick Copilot, Claude, Gemini, or Aider from the dropdown
3. **API Key** — enter the key for your chosen agent (the UI shows a link to get one)
4. **Task** — describe what the agent should do, or leave blank to auto-read `TASK.md` from the project root
5. Click **🗺 Plan** to have the agent review and ask questions first, or **▶ Start** to run fully autonomously

### Switch agent on an existing project
1. Select a running container — its agent badge shows in the container info panel
2. The **Switch agent** bar appears below — pick the new agent and click **Apply**
3. Update the API key field if needed → click **▶ Start**

### Monitor progress
- Agent logs stream live to the terminal panel
- Change documents and a summary report are written to `D:\Code\CFT\office-app\.copilot-session\` on the host after the session ends

---

## If the UI server isn't running on the host

Ask the host machine owner to run this in the `copilot-agent-docker\ui` folder:
```powershell
node server.js
```
Or from the project root:
```powershell
.\ui\start-ui.ps1 -Mode browser
```

---

## Session Details

| Item | Value |
|------|-------|
| Host Tailscale IP | `100.65.151.32` |
| UI URL | `http://100.65.151.32:3000` |
| Active project on host | `D:\Code\CFT\office-app` |
| GitHub repo | https://github.com/i84762/copilot-agent-docker |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Can't reach `100.65.151.32` | Check Tailscale is running and logged into the same network on both PCs |
| Browser shows "Connection refused" | UI server not running on host — start it with `node server.js` |
| "Docker not available" badge | Docker Desktop not running on host |
| Container won't start | Verify the API key is set and the Docker image is built (`docker image ls copilot-agent`) |
| Logs not streaming | Refresh the page and re-select the container in the dropdown |
