import { useState } from 'react';
import { commands } from '../../core/commands/registry';
import { openRecent } from '../../features/recovery/recoveryService';
import { useRecentFiles } from '../topbar/groups';

/** Shown when no tab is open: a drop zone, "Open PDF", and recent files. */
export function EmptyState() {
  const recent = useRecentFiles(6);
  // Dropped files are opened by the app root. This only highlights the zone.
  const [over, setOver] = useState(false);

  return (
    <div
      className={`empty-state${over ? ' empty-over' : ''}`}
      onDragOver={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDrop={() => setOver(false)}
    >
      <p className="empty-title">Drop a PDF here</p>
      <button type="button" className="primary-button" onClick={() => void commands.run('file.open')}>
        Open PDF
      </button>
      {recent.length > 0 && (
        <div className="recent">
          <h2>Recent files</h2>
          <ul>
            {recent.map((file) => (
              <li key={file.key}>
                <button type="button" className="link-button" onClick={() => void openRecent(file)}>
                  {file.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
