import { AlertTriangle, Eye, ExternalLink, FileText, Folder, LockKeyhole, PackageOpen, Plus, ShieldCheck } from 'lucide-react';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1000)), units.length - 1);
  const value = bytes / Math.pow(1000, index);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return 'Not available';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function getTypeLabel(node, metadata) {
  const type = metadata?.type || node?.type;
  if (type === 'directory') return 'Folder';
  if (type === 'symlink') return 'Symbolic link';
  if (type === 'special') return 'System accounting entry';
  if (type === 'bulk') return 'Smaller objects (visual group)';
  return 'File';
}

function getAccessLabel(metadata) {
  if (!metadata?.access) return 'Not available';
  if (metadata.access.readable && metadata.access.writable) return 'Read & write';
  if (metadata.access.readable) return 'Read only';
  return 'Restricted';
}

function getAccessState(metadata, risk) {
  if (risk.level === 'protected') return 'Protected by Sunburst Disk';
  if (!metadata?.access) return 'Unknown';
  if (metadata.access.readable && metadata.access.writable) return 'Accessible';
  if (metadata.access.readable) return 'Read-only';
  return 'Restricted';
}

export default function DetailsSidebar({ node, metadata, loading, risk, categoryDescription, onAddToCollector, onQuickLook, onRevealInFinder, onTogglePackageContents, packageContentsShown }) {
  const RiskIcon = risk?.Icon || AlertTriangle;
  const NodeIcon = node?.type === 'directory' ? Folder : node?.type === 'bulk' ? PackageOpen : FileText;
  const canDelete = Boolean(node && risk?.canDelete && node.path && !node.path.startsWith('__'));
  const isHiddenSpace = node?.path === '__hidden__' || (node?.type === 'special' && !node?.isHiddenSpaceRemainder);
  const canQuickLook = Boolean(node && (isHiddenSpace || metadata?.type === 'file' || metadata?.type === 'symlink' || node.type === 'file') && (isHiddenSpace || !node.path.startsWith('__')));
  const canReveal = Boolean(node?.path && !node.path.startsWith('__'));
  const packageName = String(node?.name || '').trim().toLowerCase();
  const packagePath = String(node?.path || '').trim().toLowerCase();
  const isPackageContainer = Boolean(node?.type === 'directory'
    && (packageName.endsWith('.app') || packageName.endsWith('.photoslibrary')
      || packagePath.endsWith('.app') || packagePath.endsWith('.photoslibrary')));
  const objectCount = node?.type === 'directory'
    ? (Number.isFinite(node.itemCount) ? node.itemCount : node.children?.length)
    : null;
  const objectCountLabel = isPackageContainer && !packageContentsShown
    ? 'Package contents hidden'
    : Number.isFinite(objectCount)
      ? formatCount(objectCount)
      : 'Not available';

  return (
    <aside className="details-sidebar" aria-label="Details sidebar">
      <div className="details-header">
        <div>
          <div className="details-kicker">INSPECTOR</div>
          <div className="details-title">Details</div>
        </div>
        <InfoMark />
      </div>

      {node ? (
        <>
          <div className="details-subject">
            <div className="details-subject-icon"><NodeIcon size={16} /></div>
            <div className="details-subject-copy">
              <div className="details-subject-name" title={node.path}>{node.name}</div>
              <button
                className="details-subject-path"
                title={canReveal ? 'Reveal in Finder' : 'No filesystem path available'}
                disabled={!canReveal}
                onClick={() => canReveal && onRevealInFinder?.(node.path)}
              >
                <span>{node.path}</span>
                {canReveal && <ExternalLink size={11} />}
              </button>
            </div>
            <button
              className="details-quicklook-btn"
              title={canQuickLook ? (isHiddenSpace ? 'Request access to Hidden Space' : 'Quick Look') : 'Quick Look is available for files only'}
              aria-label={canQuickLook ? (isHiddenSpace ? 'Request access to Hidden Space' : `Quick Look ${node.name}`) : 'Quick Look unavailable for folders'}
              disabled={!canQuickLook || loading}
              onClick={() => canQuickLook && onQuickLook(node)}
            >
              <Eye size={15} />
            </button>
          </div>

          <div className="details-section">
            <div className="details-section-title">Item information</div>
            <DetailRow label="Type" value={getTypeLabel(node, metadata)} />
            <DetailRow label="Size" value={formatBytes(node.size)} />
            {node.type === 'directory' && <DetailRow label="Objects inside" value={objectCountLabel} />}
            <DetailRow label="Created" value={loading ? 'Reading…' : formatDate(metadata?.createdAt)} />
            <DetailRow label="Modified" value={loading ? 'Reading…' : formatDate(metadata?.modifiedAt)} />
            <DetailRow label="Access" value={loading ? 'Reading…' : getAccessLabel(metadata)} />
            <DetailRow label="Access state" value={getAccessState(metadata, risk)} />
            <DetailRow label="Accounting model" value={metadata?.accountingModel || (node.type === 'directory' ? 'Filesystem allocation (du)' : 'Allocated blocks (du)')} />
            {metadata?.permissions && <DetailRow label="Permissions" value={metadata.permissions} mono />}
          </div>

          <div className="details-section">
            <div className="details-section-title">Category description</div>
            <p className="details-description">{categoryDescription}</p>
          </div>

          {isPackageContainer && (
            <button
              className="details-package-btn"
              disabled={!onTogglePackageContents || loading}
              onClick={() => onTogglePackageContents?.(node)}
            >
              <PackageOpen size={13} />
              {packageContentsShown ? 'Hide Package Contents' : 'Show Package Contents'}
            </button>
          )}

          <div className={`details-risk-card risk-${risk.level}`}>
            <div className="details-risk-heading">
              <RiskIcon size={15} />
              <span>{risk.label}</span>
            </div>
            <p>{risk.description}</p>
          </div>

          <button
            className="details-collector-btn"
            disabled={!canDelete}
            onClick={() => canDelete && onAddToCollector(node)}
          >
            {risk.level === 'protected' ? <LockKeyhole size={13} /> : <Plus size={13} />}
            {canDelete ? 'Add to Collector' : 'Deletion disabled'}
          </button>
        </>
      ) : (
        <div className="details-empty">
          <ShieldCheck size={18} />
          <span>Hover or select an item to inspect its details.</span>
        </div>
      )}
    </aside>
  );
}

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="details-row">
      <span className="details-row-label">{label}</span>
      <span className={`details-row-value ${mono ? 'mono' : ''}`} title={value}>{value}</span>
    </div>
  );
}

function InfoMark() {
  return <span className="details-info-mark" aria-hidden="true">i</span>;
}
