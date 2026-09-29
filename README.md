# Sunburst Disk

**A fast, safety-first macOS disk-space analyzer with an interactive sunburst.**
Rust + [Tauri v2](https://v2.tauri.app) backend, React interface. Inspects, previews and plans — never deletes on its own.

**Platform:** macOS 11+ · **Apple Silicon (arm64) only** — Intel Macs are not supported in this release.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<!-- Add a screenshot here, e.g.:
![Sunburst Disk](docs/screenshot.png)
-->

Sunburst Disk scans a disk or a single folder and renders the result as an
interactive sunburst next to a matching content tree, so the chart and the list
always describe the same hierarchy. It is a Rust/Tauri rewrite of an earlier
Electron app: the original React UI is kept, backed by a native Rust core instead
of the Electron main process.

## Safety model

Nothing is removed, moved or modified automatically. Every action is explicit and
review-oriented:

- Deleted items go to the macOS Trash (after a short confirmation delay), never
  unlinked in place.
- Protected system paths (`/`, `/System`, the Data volume's `System`, `private`
  and `usr` branches) are refused outright.
- Hidden Space and the admin Terminal mode require an explicit, per-session
  authorization and Full Disk Access where needed.
- Smart Clean is a **preview**: candidates must be selected and sent to the
  Collector by hand.

## Features

- **Interactive sunburst + content tree** sharing one hierarchy, with hover
  pulse, stable keyboard navigation and breadcrumbs.
- **In-process scanner** with `du -x` parity: it stays on one filesystem, prunes
  system junk and cloud FileProvider domains (`~/Library/CloudStorage`,
  `~/Library/Mobile Documents`), and counts each physical object once
  (filesystem boundaries, firmlinks and hardlinks de-duplicated by
  `(st_dev, st_ino)`).
- **Startup-disk view** splits the sealed OS volume from the writable Data volume
  and reconciles the difference as `hidden space...`.
- **Details inspector**: type/class, size, permissions, access, owner, timestamps
  and a category description tuned to the selected path.
- **Quick Look** (bundled Swift `QLPreviewView` panel), **Reveal in Finder**,
  **Open With** (LaunchServices via `NSWorkspace`) and **Get Info**.
- **Archive viewer**: ZIP read in-process from its central directory, other
  formats via `bsdtar`. Archives are opened read-only and never extracted.
- **Live folder updates** through FSEvents (the `notify` crate), reconciled with a
  bounded re-scan and a debounce window.
- **Collector**: drag items from the chart or tree (or use `+`) and review them
  before acting.
- **Themes** (Classic / Matrix) and a saved-folder list with per-drive scan cache.

## Hidden Space

`hidden space...` is a reconciliation entry, not a folder. Opening it asks for
Full Disk Access and then shows a diagnostic breakdown:

- **Purgeable space** — `availableCapacityForImportantUsage − availableCapacity`
  from Foundation volume resource values (the Finder/DaisyDisk definition).
- **Snapshots** — local APFS snapshots reported by `tmutil` (count; their space is
  accounted inside purgeable).
- **Diagnostic candidates** — virtual memory, system caches, Spotlight index,
  document revisions, installer sandbox.
- **Still hidden** — whatever remains of the filesystem accounting difference.

## Smart Clean

A conservative, tiered survey (Safe / Moderate / High) of regenerable data, with
every candidate carrying a reason and a verification note:

- caches, logs and saved state;
- stale/partial downloads, old installers, large downloads and old screenshots;
- duplicate files (size + sampled SHA-256 fingerprint);
- local language-model weights (`~/.cache/huggingface`, `~/.ollama/models`,
  `~/.lmstudio/models`, `~/.cache/whisper`, GPT4All) that can be re-downloaded;
- Apple device backups (`~/Library/Application Support/MobileSync/Backup`);
- Xcode simulator systems and device support (`CoreSimulator/Devices`,
  `CoreSimulator/Images`, `Xcode/iOS DeviceSupport`, `Xcode/Archives`);
- other caches/logs/language resources (`~/.npm/_cacache`, `CrashReporter`,
  `Library/Speech`).

## Terminal

An allow-listed, read-only helper (`pwd`, `df -h`, `ls …`, `du -sh`). A
password-authenticated **admin** mode unlocks a small set of write commands
(`touch`, `mkdir -p`, `rm`, `mv`, `cp -R`, `ln -s`) scoped to the current,
non-protected folder and executed through `sudo -n`. Arbitrary shell, unlisted
flags and protected roots stay blocked.

## Ask Siri

A context-menu action sends a bounded description of the selected object to a
user-created Shortcut (`Sunburst Disk — Ask Siri`) via `/usr/bin/shortcuts run`
and shows the returned text in an in-app panel, with Expand / Shorten / Bullet
List / Copy. See `docs/how-to-create-sunburst-disk-ask-siri-shortcut.md`.

## Architecture

```
React renderer ──► window.electronAPI (src/tauri-bridge.js)
                        │
                        ▼
        Tauri commands (src-tauri/src/commands.rs)
                        │
                        ▼
   Rust core (scan · capacity · drives · inspect · related · openwith ·
              watcher · archive · smart_clean · hidden_space · terminal ·
              ask_siri · quick_look)  ──► macOS CLIs + one bundled Swift helper
```

`src/tauri-bridge.js` maps `window.electronAPI.*` onto Tauri `invoke`/`listen`,
so the renderer stayed almost unchanged through the migration. The full port
log and the deliberate parity deltas live in
`docs/electron-to-tauri-migration.md`.

## Requirements

- macOS 11 or later on **Apple Silicon (arm64)**. Intel Macs are **not**
  supported in this release.
- macOS 26+ additionally shows the dark/tinted app icon.
- To build from source: Node.js 20+, a Rust toolchain, and Xcode (for the Quick
  Look helper and the Icon Composer icon).

## Install

Download `Sunburst Disk_0.3.3_aarch64.dmg` from
[Releases](../../releases), open it and drag **Sunburst Disk** to *Applications*.

> **Apple Silicon only.** The `aarch64` build runs on M-series Macs. Intel
> (`x86_64`) is not supported in this release; a universal build is planned.

## Build from source

```bash
npm install
npm run tauri:dev        # dev build with the Vite dev server
```

Release bundle (`.app` + `.dmg`):

```bash
npm run build:quicklook  # compile the Quick Look Swift helper (once)
npm run tauri:build
```

Rust checks (no webview needed):

```bash
npm run rust:test        # cargo test --lib
npm run rust:lint        # cargo clippy --lib --bins, warnings are errors
npm run rust:test:all    # also bins + doctests
npm run rust:lint:all    # clippy --all-targets
```

The macOS 26 icon is generated from `src-tauri/icons/Sunburst Disk.icon` with
`actool`; `npm run build:icon` regenerates it (needs Xcode). The compiled
outputs are committed, so a normal build does not need Xcode.

## Project structure

```text
.
├── electron/quicklook-preview{,.swift}   # bundled Quick Look helper (+ source)
├── public/
├── scripts/build-icon.sh                 # .icon → Assets.car + icon.icns (actool)
├── src/                                  # React UI (App.jsx, components, bridge)
├── src-tauri/                            # Rust core, Tauri commands, icons, config
│   ├── src/
│   ├── icons/
│   ├── capabilities/
│   ├── Info.plist
│   └── tauri.conf.json
└── docs/
```

## Documentation

- `docs/electron-to-tauri-migration.md` — architecture, command status, parity notes.
- `docs/how-to-create-sunburst-disk-ask-siri-shortcut.md` — Ask Siri setup.
- `docs/archive-preview-design.md` — archive viewer design.

## License

[MIT](LICENSE).

---

<details>
<summary>🇷🇺 Русский</summary>

# Sunburst Disk

**Быстрый и безопасный анализатор дискового пространства macOS с интерактивной
sunburst-диаграммой.** Бэкенд на Rust + [Tauri v2](https://v2.tauri.app),
интерфейс на React. Приложение только анализирует, показывает предпросмотр и
планирует — само ничего не удаляет.

Sunburst Disk сканирует диск или отдельную папку и рисует результат как
интерактивную sunburst-диаграмму рядом с тем же деревом каталогов, поэтому
диаграмма и список всегда описывают одну иерархию. Это переписывание прежнего
Electron-приложения на Rust/Tauri: исходный React-интерфейс сохранён, но работает
поверх нативного Rust-ядра.

## Безопасность

Ничего не удаляется и не изменяется автоматически:

- удаление — только в системную Корзину (после короткой задержки-подтверждения);
- защищённые системные пути (`/`, `/System`, ветви `System`, `private`, `usr`
  Data-тома) отклоняются;
- Hidden Space и admin-режим Терминала требуют явной авторизации на сессию и, при
  необходимости, Full Disk Access;
- Smart Clean — только предпросмотр: кандидаты нужно явно выбрать и отправить в
  Collector.

## Возможности

- **Sunburst + content tree** по одной иерархии, пульсация hover, устойчивая
  навигация с клавиатуры, breadcrumbs.
- **Сканер в процессе** с паритетом `du -x`: остаётся в пределах одной файловой
  системы, исключает системный мусор и облачные FileProvider-домены
  (`~/Library/CloudStorage`, `~/Library/Mobile Documents`) и считает каждый
  физический объект один раз (границы ФС, firmlink-и и hardlink-и
  дедуплицируются по `(st_dev, st_ino)`).
- **Системный диск** разделяется на sealed OS-том и записываемый Data-том, а
  разница показывается как `hidden space...`.
- **Инспектор**: тип/класс, размер, права, владелец, даты и описание категории для
  выбранного пути.
- **Quick Look** (встроенный Swift-хелпер `QLPreviewView`), **Reveal in Finder**,
  **Open With** (LaunchServices через `NSWorkspace`) и **Get Info**.
- **Просмотр архивов**: ZIP читается в процессе по central directory, остальные
  форматы — через `bsdtar`; только чтение, без распаковки.
- **Живые обновления** открытой папки через FSEvents (crate `notify`).
- **Collector**: перетаскивание из диаграммы или дерева (или кнопка `+`).
- **Темы** Classic / Matrix и список сохранённых папок с кэшем сканов.

## Hidden Space

`hidden space...` — это reconciliation-запись, а не папка. При открытии
запрашивается Full Disk Access и показывается разбивка:

- **Purgeable space** — `availableCapacityForImportantUsage − availableCapacity`
  (определение Finder/DaisyDisk);
- **Snapshots** — локальные APFS-снимки из `tmutil` (количество; их место учтено
  в purgeable);
- **диагностические кандидаты** — virtual memory, системные кэши, индекс
  Spotlight, document revisions, installer sandbox;
- **Still hidden** — остаток файловой разницы.

## Smart Clean

Консервативный обзор по уровням (Safe / Moderate / High) с причиной и способом
проверки для каждого кандидата: кэши, логи и saved state; незавершённые загрузки,
старые инсталляторы, крупные загрузки и старые скриншоты; дубликаты файлов
(размер + выборочный SHA-256); локальные веса языковых моделей
(`~/.cache/huggingface`, `~/.ollama/models`, `~/.lmstudio/models`,
`~/.cache/whisper`, GPT4All); резервные копии устройств Apple
(`~/Library/Application Support/MobileSync/Backup`); симуляторы и device support
Xcode (`CoreSimulator/Devices`, `CoreSimulator/Images`, `Xcode/iOS DeviceSupport`,
`Xcode/Archives`); прочие кэши/логи/языковые ресурсы (`~/.npm/_cacache`,
`CrashReporter`, `Library/Speech`).

## Терминал

Read-only хелпер по allowlist (`pwd`, `df -h`, `ls …`, `du -sh`).
Пароль-авторизованный **admin**-режим открывает небольшой набор write-команд
(`touch`, `mkdir -p`, `rm`, `mv`, `cp -R`, `ln -s`) в пределах текущей
незащищённой папки через `sudo -n`. Произвольный shell, неразрешённые флаги и
защищённые корни блокируются.

## Требования и сборка

macOS 11+ на **Apple Silicon (arm64)** — Intel-маки в этом релизе **не
поддерживаются**. Для сборки из исходников: Node.js 20+, Rust toolchain и Xcode
(для Quick Look-хелпера и иконки Icon Composer).

```bash
npm install
npm run tauri:dev        # разработка
npm run build:quicklook  # собрать Swift-хелпер Quick Look (один раз)
npm run tauri:build      # релиз .app + .dmg
npm run rust:test        # тесты Rust
npm run rust:lint        # clippy (warnings = errors)
```

Установка: скачайте DMG из [Releases](../../releases) и перетащите **Sunburst
Disk** в *Applications*.

## Лицензия

[MIT](LICENSE).

</details>
