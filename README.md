# FS Repo Manager

Docker Registry v2 management UI for tagging, pushing, and managing images across your registries.

## Features

- **Image folder**: Recursively scans a configurable folder for `docker save` tar files. Scan on load (cached) or on demand via "Scan now". State persisted in SQLite.
- **Grouped by folder**: Images are grouped by subfolder (e.g. `Build0012/`) with collapsible sections.
- **Registry presence**: Icons show whether each image is already pushed to each configured registry (✓ or —).
- **Tag & push**: Load images from tars, push to one or more registries. Single or multi-select with bulk push.
- **Editable registries**: Add registries in Settings with hostname and port. Stored in SQLite. New setups start with no registries—add your own.
- **Registry browser**: List repositories and tags per registry, delete tags manually.
- **Push progress**: Progress bar, queue view, elapsed time. Minimize to browse away; floating indicator lets you recover status.
- **Cleanup**: Docker images (loaded + tagged) are removed after successful push.

## Requirements

- Docker
- Docker daemon (for load, tag, push)
- Container must run on the machine with Docker access

## Quick Start

```bash
docker compose up -d --build
```

Opens at http://localhost:3000.

1. Go to **Settings** and add your registries (hostname + port).
2. Place tar files in the `./images/` folder (relative to the project). This folder is mounted into the container, so the app reads from your local files. Subfolders are supported—images are grouped by folder in the UI.

   Example layout:

   ```
   FS-Repo-Manager/
   └── images/
       ├── Build0012/
       │   ├── myapp-v1.0.tar
       │   └── sidecar-v1.0.tar
       └── Build0013/
           └── myapp-v1.1.tar
   ```

   To use a different path, change the volume in `docker-compose.yml` (e.g. `- /path/to/your/tars:/app/images`).

3. Open **Folder**, click "Scan now" to discover images, then push as needed.

**Stop:** `docker compose down`

## Configuration

- **WATCH_FOLDER**: Path containing tar files. Default: `./images` (local) or `/app/images` (container)
- **PORT**: Backend port. Default: 3001 (container maps host 3000 → 3001)
- **DB_PATH**: SQLite database path. Default: `./data/fs-repo-manager.db`

## Data persistence (Docker)

The `./data` folder is mounted so registries and scan cache persist across container restarts.
