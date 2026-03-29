function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2.5 border-b border-white/5 last:border-0">
      <span className="flex-none w-40 text-xs text-white/40 font-mono pt-0.5">{label}</span>
      <span className="flex-1 text-xs text-white/65 leading-relaxed">{children}</span>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-md bg-accent/8 border border-accent/20 px-3 py-2 text-xs text-white/50 leading-relaxed">
      {children}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 rounded-md bg-amber-500/8 border border-amber-500/20 px-3 py-2 text-xs text-amber-300/70 leading-relaxed">
      {children}
    </div>
  );
}

export default function AboutTab() {
  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-thin p-8 max-w-3xl mx-auto">

      {/* ── Identity ──────────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white tracking-tight">
          Pete the Computer Geek Backup Tool
        </h2>
        <p className="text-sm text-white/40 mt-1">Version 0.1.0</p>
        <p className="text-sm text-white/55 mt-3 leading-relaxed">
          A Windows profile backup and restore tool built for technicians. Copies user
          data — documents, desktop, pictures, browser bookmarks, Outlook mail stores —
          from any source profile to a destination folder or directly into another
          Windows user account. Handles OneDrive Known Folder Move (KFM) transparently
          so files always land in the right place after a restore.
        </p>
      </div>

      <div className="border-t border-white/8 mb-8" />

      {/* ── Requirements ─────────────────────────────────────────────────────── */}
      <Section title="Requirements">
        <div className="rounded-lg bg-elevated/60 border border-white/8 divide-y divide-white/5">
          <Row label="Administrator">
            The app must run as Administrator to read other users' profile folders
            (e.g. <span className="font-mono text-white/50">C:\Users\OtherUser</span>).
            A warning banner appears at the top of the Backup and Restore tabs if
            admin rights are not detected. Reinstall using the NSIS installer (perMachine)
            to get a proper UAC-elevated launch.
          </Row>
          <Row label="Windows 10/11">
            Designed and tested on Windows 10 1709+ and Windows 11. OneDrive
            Files-On-Demand placeholder detection requires Windows 10 1709 or later.
          </Row>
        </div>
      </Section>

      {/* ── Backup tab ───────────────────────────────────────────────────────── */}
      <Section title="Backup Tab">
        <p className="text-xs text-white/45 leading-relaxed mb-4">
          Copies a source Windows user profile to a destination folder on any drive.
          A <span className="font-mono text-white/60">manifest.json</span> file is
          written alongside the backup so the Restore tab can read all metadata
          (date, file count, folders, source computer) without opening the backup folder.
        </p>

        <div className="rounded-lg bg-elevated/60 border border-white/8 divide-y divide-white/5 mb-4">
          <Row label="Source User">
            Pick any local Windows profile found under{' '}
            <span className="font-mono text-white/50">C:\Users\</span>. The list shows
            each account's display name, SID, and total profile size. Profiles belonging
            to system accounts (Default, Public, All Users) are excluded.
          </Row>
          <Row label="Destination">
            The folder where the backup will be created. A subfolder named after the
            source username is appended automatically, so you only need to point at
            the root of your external drive or network share. The folder is created
            if it doesn't exist.
          </Row>
          <Row label="Folders Included">
            Standard shell folders are always included: Desktop, Documents, Downloads,
            Pictures, Music, Videos, and Favorites. Their real paths are read from the
            Windows registry (Shell Folders key) so renamed or relocated folders are
            handled correctly.
          </Row>
          <Row label="Extra Folders">
            Any non-standard folder found in the profile root that isn't part of the
            standard set is listed here with its size. Check any you want to include —
            for example, a custom <span className="font-mono text-white/50">Projects\</span>{' '}
            or <span className="font-mono text-white/50">Saved Games\</span> folder.
          </Row>
          <Row label="Browser Data">
            Detected browsers are shown based on whether their AppData folder actually
            exists. Only bookmark files are copied — not cache, history, cookies, or
            passwords. See the App Data section below for per-browser details.
          </Row>
          <Row label="Direct Restore Mode">
            Instead of writing to a backup folder, copies the source profile directly
            into an existing local user account. Useful for in-place migrations on the
            same machine. No manifest is written. Cancel will not delete files (the
            destination is a live profile).
          </Row>
          <Row label="Dry Run">
            Scans and logs every file that would be copied without writing anything to
            disk. Use this to verify the source, check the file count and size, and
            confirm paths before committing. The log tab will show the full{' '}
            <span className="font-mono text-white/50">[DRY RUN]</span> output.
          </Row>
        </div>

        <Note>
          <strong className="text-white/70">OneDrive + KFM during backup:</strong> If the
          source user has OneDrive Known Folder Move active, standard folders
          (Documents, Desktop, Pictures, etc.) are actually stored inside the OneDrive
          folder. The backup engine detects this via the registry and backs up the entire
          OneDrive root as a single "OneDrive" source, skipping the shell folder
          symlinks to avoid duplicating files.
        </Note>

        <Warn>
          <strong className="text-amber-300/90">Cloud-only placeholders are skipped.</strong>{' '}
          OneDrive Files-On-Demand files that haven't been downloaded locally show as
          0-byte placeholder stubs on disk. Attempting to read them would trigger a
          network recall. The backup engine detects these via Windows file attributes
          (<span className="font-mono">RECALL_ON_DATA_ACCESS</span>,{' '}
          <span className="font-mono">RECALL_ON_OPEN</span>,{' '}
          <span className="font-mono">OFFLINE</span>) and skips them with a{' '}
          <span className="font-mono">[CLOUD]</span> warning in the log. Only files
          that are fully local are backed up.
        </Warn>
      </Section>

      {/* ── Restore tab ──────────────────────────────────────────────────────── */}
      <Section title="Restore Tab">
        <p className="text-xs text-white/45 leading-relaxed mb-4">
          Restores files from an external drive into a local Windows user profile.
          The tool scans every connected drive (A–Z, except C:) automatically on load
          and groups restore sources by drive letter.
        </p>

        <div className="rounded-lg bg-elevated/60 border border-white/8 divide-y divide-white/5 mb-4">
          <Row label="Managed source">
            A backup folder created by this tool. Contains a{' '}
            <span className="font-mono text-white/50">manifest.json</span> with the
            original username, source computer, date, total file count, folder list,
            and OneDrive path. Shown with a blue "Managed" badge. Selecting one
            expands a detail card with all manifest fields.
          </Row>
          <Row label="Unmanaged source">
            A raw Windows user profile found under a{' '}
            <span className="font-mono text-white/50">\Users\</span> directory on the
            external drive — typically from a pulled hard disk. No manifest is
            available. The tool copies standard folders (Desktop, Documents, etc.)
            and any OneDrive folder it finds. Shown with an amber "Unmanaged" badge.
          </Row>
          <Row label="Restore Into">
            The local Windows user account to restore files into. Files are written
            directly to that profile's folder under{' '}
            <span className="font-mono text-white/50">C:\Users\{'{username}'}</span>.
            The target user does not need to be logged in.
          </Row>
          <Row label="Dry Run">
            Same as on the Backup tab — logs every file that would be written without
            touching the filesystem. The Start button label changes to "Test Run" when
            dry run is active.
          </Row>
        </div>

        <Note>
          <strong className="text-white/70">OneDrive KFM during restore:</strong> If the
          backup was taken from a machine where KFM was active, the standard folders
          (Documents, Desktop, Pictures, etc.) will be inside the backup's{' '}
          <span className="font-mono text-white/50">OneDrive\</span> subfolder.
          The restore engine detects this automatically: any standard folder found
          directly inside <span className="font-mono text-white/50">backup\OneDrive\</span>{' '}
          is redirected to its standard profile location (e.g.{' '}
          <span className="font-mono text-white/50">C:\Users\NewUser\Documents</span>),
          so Windows libraries show the files correctly without requiring OneDrive
          to be set up on the new machine. Non-standard OneDrive subfolders go to{' '}
          <span className="font-mono text-white/50">C:\Users\NewUser\OneDrive\</span> as normal.
        </Note>
      </Section>

      {/* ── App data ─────────────────────────────────────────────────────────── */}
      <Section title="App Data">
        <p className="text-xs text-white/45 leading-relaxed mb-4">
          For browsers, only bookmark-related files are copied — no cache, history, cookies,
          sessions, or passwords. This keeps backup size small and avoids copying data that
          would be invalid on a new machine anyway.
        </p>
        <div className="rounded-lg bg-elevated/60 border border-white/8 divide-y divide-white/5">
          <Row label="Chrome">
            <span className="font-mono text-white/50">Default\Bookmarks</span> and{' '}
            <span className="font-mono text-white/50">Default\Bookmarks.bak</span>{' '}
            from the Chrome User Data folder.
          </Row>
          <Row label="Edge">
            Same as Chrome —{' '}
            <span className="font-mono text-white/50">Default\Bookmarks</span> and{' '}
            <span className="font-mono text-white/50">Default\Bookmarks.bak</span>.
          </Row>
          <Row label="Brave">
            Same as Chrome —{' '}
            <span className="font-mono text-white/50">Default\Bookmarks</span> and{' '}
            <span className="font-mono text-white/50">Default\Bookmarks.bak</span>.
          </Row>
          <Row label="Opera">
            Same as Chrome —{' '}
            <span className="font-mono text-white/50">Default\Bookmarks</span> and{' '}
            <span className="font-mono text-white/50">Default\Bookmarks.bak</span>.
          </Row>
          <Row label="Firefox">
            All files inside the{' '}
            <span className="font-mono text-white/50">bookmarkbackups\</span> subfolder
            of the Firefox profile (dated JSON bookmark snapshot files).
          </Row>
          <Row label="Outlook">
            Only <span className="font-mono text-white/50">.pst</span> files (Personal
            Storage Table — mail, contacts, calendar). OST files (offline cache) are
            excluded as they are regenerated automatically by Outlook.
          </Row>
          <Row label="Thunderbird">
            The full Thunderbird profiles folder is copied, except the regenerable cache
            directories:{' '}
            <span className="font-mono text-white/50">cache2\</span>,{' '}
            <span className="font-mono text-white/50">startupCache\</span>, and{' '}
            <span className="font-mono text-white/50">OfflineCache\</span>.
          </Row>
          <Row label="QuickBooks">
            Company files (<span className="font-mono text-white/50">.QBW</span>) saved
            inside the user profile (Documents, Desktop, etc.) are covered automatically
            by the standard folder backup. If data also exists at the installer default{' '}
            <span className="font-mono text-white/50">C:\Users\Public\Documents\Intuit\</span>,
            the Backup tab detects this and shows a{' '}
            <strong className="text-white/70">QuickBooks Data</strong> toggle — enable it
            to include that shared location in the backup.
          </Row>
        </div>
      </Section>

      {/* ── Logs tab ─────────────────────────────────────────────────────────── */}
      <Section title="Logs Tab">
        <div className="rounded-lg bg-elevated/60 border border-white/8 divide-y divide-white/5 mb-4">
          <Row label="Log file location">
            <span className="font-mono text-white/50">
              %APPDATA%\com.pete.ptcg-backup-tool\logs\ptcg-backup-tool.log
            </span>
          </Row>
          <Row label="Log level">
            Debug and above — all info, warnings, and errors from the backup and
            restore engines are captured. Cloud placeholder skips appear as{' '}
            <span className="font-mono text-white/50">[CLOUD]</span> warnings.
            Dry run file listings appear as{' '}
            <span className="font-mono text-white/50">[DRY RUN]</span> info entries.
          </Row>
          <Row label="In-app viewer">
            The Logs tab reads the last 64 KB of the log file. Older entries are
            trimmed with an "earlier entries omitted" notice. Click "Open Log File"
            to open the full log in your default text editor.
          </Row>
          <Row label="Error logs">
            If a backup or restore encounters per-file errors, a separate{' '}
            <span className="font-mono text-white/50">errors.log</span> or{' '}
            <span className="font-mono text-white/50">restore_errors.log</span> is
            written inside the backup folder itself for easy reference alongside
            the backup data.
          </Row>
        </div>
      </Section>

      {/* ── Built with ───────────────────────────────────────────────────────── */}
      <Section title="Built With">
        <div className="flex flex-wrap gap-2">
          {['Tauri 2', 'Rust', 'React 19', 'TypeScript', 'Tailwind CSS v3'].map((tech) => (
            <span
              key={tech}
              className="text-xs px-2.5 py-1 rounded-md bg-white/5 text-white/50 border border-white/8"
            >
              {tech}
            </span>
          ))}
        </div>
      </Section>

      <div className="border-t border-white/8 mb-8" />

      {/* ── License ──────────────────────────────────────────────────────────── */}
      <Section title="License">
        <div className="rounded-lg bg-white/3 border border-white/8 p-4 text-xs text-white/40 font-mono leading-relaxed whitespace-pre-wrap">{`MIT License

Copyright (c) 2025 Pete the Computer Geek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`}</div>
      </Section>

    </div>
  );
}
