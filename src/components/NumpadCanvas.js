import React, { useState, useEffect } from 'react';
import './NumpadCanvas.css';
import { comboString } from './KeyboardCanvas';

// ── Numpad key grid (CSS-grid positions, 4 cols × 5 rows) ───────────────────
const NUMPAD_KEYS = [
  { id: 'NumLock',        label: 'Num\nLock', col: 1, row: 1, colSpan: 1, rowSpan: 1 },
  { id: 'NumpadDivide',   label: '/',          col: 2, row: 1, colSpan: 1, rowSpan: 1 },
  { id: 'NumpadMultiply', label: '×',          col: 3, row: 1, colSpan: 1, rowSpan: 1 },
  { id: 'NumpadSubtract', label: '−',          col: 4, row: 1, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad7',        label: '7',          col: 1, row: 2, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad8',        label: '8',          col: 2, row: 2, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad9',        label: '9',          col: 3, row: 2, colSpan: 1, rowSpan: 1 },
  { id: 'NumpadAdd',      label: '+',          col: 4, row: 2, colSpan: 1, rowSpan: 2 },
  { id: 'Numpad4',        label: '4',          col: 1, row: 3, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad5',        label: '5',          col: 2, row: 3, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad6',        label: '6',          col: 3, row: 3, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad1',        label: '1',          col: 1, row: 4, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad2',        label: '2',          col: 2, row: 4, colSpan: 1, rowSpan: 1 },
  { id: 'Numpad3',        label: '3',          col: 3, row: 4, colSpan: 1, rowSpan: 1 },
  { id: 'NumpadEnter',    label: 'Enter',      col: 4, row: 4, colSpan: 1, rowSpan: 2 },
  { id: 'Numpad0',        label: '0',          col: 1, row: 5, colSpan: 2, rowSpan: 1 },
  { id: 'NumpadDecimal',  label: '.',          col: 3, row: 5, colSpan: 1, rowSpan: 1 },
];

export default function NumpadCanvas({
  selectedKey,
  onKeySelect,
  getKeyAssignment,
  lastFired,
  activeModifiers,
}) {
  const [firingKeyId, setFiringKeyId] = useState(null);

  useEffect(() => {
    if (lastFired?.keyId?.startsWith('Numpad') || lastFired?.keyId === 'NumLock') {
      setFiringKeyId(lastFired.keyId);
      const t = setTimeout(() => setFiringKeyId(null), 600);
      return () => clearTimeout(t);
    }
  }, [lastFired]);

  const noLayer = activeModifiers.length === 0;
  const combo   = comboString(activeModifiers);

  function keyClass(id) {
    const isSelected = selectedKey === id;
    const isAssigned = !!getKeyAssignment(id);
    const isFiring   = firingKeyId === id;
    return [
      'np-key',
      isSelected ? 'selected'  : '',
      isAssigned ? 'assigned'  : '',
      isFiring   ? 'firing'    : '',
      noLayer    ? 'no-layer'  : '',
    ].filter(Boolean).join(' ');
  }

  function keyTitle(id, label) {
    const displayLabel = label.replace('\n', ' ');
    if (noLayer) return 'Select a modifier layer above first';
    if (getKeyAssignment(id)) return `Click to edit: ${displayLabel}`;
    return `Assign macro to: ${combo}+${displayLabel}`;
  }

  return (
    <div className="numpad-canvas">
      <div className="numpad-label">Numpad</div>
      <div className="numpad-grid">
        {NUMPAD_KEYS.map(({ id, label, col, row, colSpan, rowSpan }) => {
          const isAssigned = !!getKeyAssignment(id);
          const isSelected = selectedKey === id;
          return (
            <button
              key={id}
              className={keyClass(id)}
              style={{
                gridColumn: colSpan > 1 ? `${col} / span ${colSpan}` : col,
                gridRow:    rowSpan > 1 ? `${row} / span ${rowSpan}` : row,
              }}
              onClick={noLayer ? undefined : () => onKeySelect(id)}
              title={keyTitle(id, label)}
              type="button"
            >
              <span className="np-key-label">{label}</span>
              {isAssigned && !isSelected && <span className="np-key-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
