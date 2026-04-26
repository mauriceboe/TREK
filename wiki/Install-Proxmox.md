# Install: Proxmox VE (LXC)

Install TREK on Proxmox VE as an LXC container using the [Proxmox VE Community Scripts](https://community-scripts.org/scripts/trek).

> A big thank you to the members of [community-scripts](https://github.com/community-scripts) for adding TREK to their collection and maintaining the install and update scripts.

## Prerequisites

- Proxmox VE with shell access
- Internet access from the Proxmox host

## Install

Run the following command in the **Proxmox VE Shell**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/trek.sh)"
```

> **Tip:** Always verify the latest command on the [community-scripts TREK page](https://community-scripts.org/scripts/trek) before running — the script URL may change between releases.

The script will prompt you to choose between **Default** and **Advanced** settings.

### Default container specs

| Resource | Value |
|---|---|
| OS | Debian 13 |
| CPU | 2 cores |
| RAM | 2048 MB |
| Storage | 8 GB |
| Port | 3000 |

The container is unprivileged. TREK is installed at `/opt/trek`.

## After Install

Once the container starts, open your browser at:

```
http://<container-ip>:3000
```

On first boot, TREK automatically creates an admin account. The credentials are printed to the container log — check them with:

```bash
journalctl -u trek -n 50
```

The `ENCRYPTION_KEY` is auto-generated during setup and saved to `/opt/trek/server/.env`. Record that file in your backups.

## Viewing Logs

TREK runs as a systemd service named `trek` inside the LXC. To view logs from within the container:

```bash
# Follow live logs
journalctl -u trek -f

# Show last 100 lines
journalctl -u trek -n 100

# Show logs since last boot
journalctl -u trek -b
```

To access the container shell from the Proxmox VE host, click the container in the UI and open **Console**, or run:

```bash
pct enter <container-id>
```

## Configuration

The environment file is located at `/opt/trek/server/.env` inside the container. Edit it to set variables like `ALLOWED_ORIGINS`, `APP_URL`, or `TZ`, then restart the service:

```bash
systemctl restart trek
```

See [Environment-Variables](Environment-Variables) for the full variable reference.

## Updating

Run the following command inside the **LXC container** and select **Update** when prompted:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/trek.sh)"
```

> **Tip:** Always check the [community-scripts TREK page](https://community-scripts.org/scripts/trek) to confirm the latest command before running.

The script stops the service, backs up your data and uploads, applies the new release, restores the backup, and restarts. No manual steps required.

## Next Steps

- [Environment-Variables](Environment-Variables) — complete variable reference
- [Reverse-Proxy](Reverse-Proxy) — put TREK behind Nginx or Caddy
- [Updating](Updating) — general update notes
