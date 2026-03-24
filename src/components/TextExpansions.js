import React, { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import './TextExpansions.css';

// ── Helpers ────────────────────────────────────────────────────────────────

function htmlToPlainText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/div>/gi, '\n');
  // Replace token chips with their raw token strings before stripping markup
  tmp.querySelectorAll('[data-token]').forEach(el => {
    el.replaceWith(document.createTextNode(el.dataset.token));
  });
  return (tmp.textContent || tmp.innerText || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Insert token menu definition ───────────────────────────────────────────

const INSERT_MENU = [
  { type: 'item', token: '{clipboard}',       label: 'Clipboard Contents',  display: 'Clipboard'  },
  { type: 'sep'  },
  { type: 'item', token: '{date:DD/MM/YYYY}', label: 'Date (DD/MM/YYYY)',   display: 'DD/MM/YYYY' },
  { type: 'item', token: '{date:MM/DD/YYYY}', label: 'Date (MM/DD/YYYY)',   display: 'MM/DD/YYYY' },
  { type: 'item', token: '{date:YYYY-MM-DD}', label: 'Date (YYYY-MM-DD)',   display: 'YYYY-MM-DD' },
  { type: 'item', token: '{time:HH:MM}',      label: 'Time (HH:MM)',        display: 'HH:MM'      },
  { type: 'item', token: '{time:HH:MM:SS}',   label: 'Time (HH:MM:SS)',     display: 'HH:MM:SS'   },
  { type: 'item', token: '{dayofweek}',        label: 'Day of Week',         display: 'Day'        },
  { type: 'sep'  },
  { type: 'item', token: '{cursor}',           label: 'Cursor Position',     display: '↕ Cursor'   },
  { type: 'item', token: '__fillin__',          label: 'Fill-in Field…',      display: null         },
];

// Generate a consistent colour from a category name
function categoryColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 58%, 52%)`;
}

// ── Rich text editor ───────────────────────────────────────────────────────

function RichTextEditor({ initialHtml, onChange }) {
  const editorRef      = useRef(null);
  const btnRef         = useRef(null);
  const menuRef        = useRef(null);
  const initialHtmlRef = useRef(initialHtml);
  // Saved selection range — captured before the dropdown opens so that focus
  // loss (e.g. when the fill-in label input steals focus) doesn't destroy the
  // insertion point.
  const savedRangeRef  = useRef(null);

  const [showInsert, setShowInsert] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const [fillInEntry, setFillInEntry] = useState(false);
  const [fillInLabel, setFillInLabel] = useState('');
  const fillInInputRef = useRef(null);

  useLayoutEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = initialHtmlRef.current || '';
    }
  }, []);

  // When fill-in entry mode activates, focus the label input.
  // The input is always mounted (CSS-hidden), so the ref is always valid —
  // no setTimeout needed, focus is immediate.
  useEffect(() => {
    if (fillInEntry) {
      fillInInputRef.current?.focus();
    }
  }, [fillInEntry]);

  // Close dropdown on outside click or any scroll — only mounted while open
  useEffect(() => {
    if (!showInsert) return;

    function close() {
      setShowInsert(false);
      setFillInEntry(false);
      setFillInLabel('');
    }
    function onMouseDown(e) {
      if (!btnRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) {
        close();
      }
    }

    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', close, { capture: true });
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', close, { capture: true });
    };
  }, [showInsert]);

  const notify = useCallback(() => {
    const html = editorRef.current.innerHTML;
    onChange({ html, text: htmlToPlainText(html) });
  }, [onChange]);

  function format(cmd) {
    editorRef.current?.focus();
    document.execCommand(cmd, false, null);
    notify();
  }

  function isActive(cmd) {
    try { return document.queryCommandState(cmd); } catch { return false; }
  }

  // Snapshot the current cursor/selection inside the editor so we can restore
  // it later even after focus has moved elsewhere (e.g. fill-in label input).
  function saveSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }

  // Restore focus + cursor to the saved position before inserting content.
  function restoreSelection() {
    editorRef.current?.focus();
    const range = savedRangeRef.current;
    if (!range) return;
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  function insertTokenHtml(tokenStr, display) {
    console.log('insertTokenHtml called', { tokenStr, display, savedRange: savedRangeRef.current });
    restoreSelection();

    const sel = window.getSelection();
    console.log('after restoreSelection — rangeCount:', sel?.rangeCount, 'focused:', document.activeElement === editorRef.current);

    const span = document.createElement('span');
    span.className = 'rte-token';
    span.setAttribute('data-token', tokenStr);
    span.setAttribute('contenteditable', 'false');
    span.textContent = display;
    const zwsp = document.createTextNode('\u200B');

    if (sel && sel.rangeCount > 0) {
      console.log('inserting via Range API');
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const frag = document.createDocumentFragment();
      frag.appendChild(span);
      frag.appendChild(zwsp);
      range.insertNode(frag);

      // Move cursor to just after the zero-width space
      const newRange = document.createRange();
      newRange.setStartAfter(zwsp);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    } else {
      // Fallback: no cursor position — append to end of editor
      console.warn('insertTokenHtml: no selection, appending to end of editor');
      editorRef.current.focus();
      editorRef.current.appendChild(span);
      editorRef.current.appendChild(zwsp);
    }

    notify();
    savedRangeRef.current = null;
  }

  function handleInsertItem(e, item) {
    e.preventDefault();
    console.log('MENU ITEM CLICKED', item.token);
    if (item.token === '__fillin__') {
      console.log('FILL-IN ENTRY MODE');
      setFillInEntry(true);
      setFillInLabel('');
      return;
    }
    insertTokenHtml(item.token, item.display);
    setShowInsert(false);
  }

  function handleInsertFillIn(e) {
    e.preventDefault();
    const label = fillInLabel.trim() || 'Field';
    console.log('handleInsertFillIn', { label, savedRange: savedRangeRef.current });
    insertTokenHtml(`{fillIn:${label}}`, `✎ ${label}`);
    setFillInEntry(false);
    setFillInLabel('');
    setShowInsert(false);
  }

  return (
    <div className="rte-wrap">
      <div className="rte-toolbar">
        <button
          type="button"
          className={`rte-btn rte-bold${isActive('bold') ? ' rte-btn-on' : ''}`}
          onMouseDown={e => { e.preventDefault(); format('bold'); }}
          title="Bold"
        ><b>B</b></button>
        <button
          type="button"
          className={`rte-btn rte-italic${isActive('italic') ? ' rte-btn-on' : ''}`}
          onMouseDown={e => { e.preventDefault(); format('italic'); }}
          title="Italic"
        ><i>I</i></button>
        <div className="rte-sep" />
        <button
          type="button"
          className="rte-btn"
          onMouseDown={e => { e.preventDefault(); format('insertUnorderedList'); }}
          title="Bullet list"
        >
          <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
            <circle cx="1.5" cy="2" r="1.5" fill="currentColor"/>
            <circle cx="1.5" cy="6" r="1.5" fill="currentColor"/>
            <circle cx="1.5" cy="10" r="1.5" fill="currentColor"/>
            <line x1="5" y1="2" x2="13" y2="2" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="5" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="5" y1="10" x2="13" y2="10" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>
        <button
          type="button"
          className="rte-btn"
          onMouseDown={e => { e.preventDefault(); format('insertOrderedList'); }}
          title="Numbered list"
        >
          <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
            <text x="0" y="3.5" fontSize="4" fill="currentColor" fontWeight="700">1.</text>
            <text x="0" y="7.5" fontSize="4" fill="currentColor" fontWeight="700">2.</text>
            <text x="0" y="11" fontSize="4" fill="currentColor" fontWeight="700">3.</text>
            <line x1="5" y1="2" x2="13" y2="2" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="5" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1.5"/>
            <line x1="5" y1="10" x2="13" y2="10" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        </button>

        <div className="rte-sep" />

        {/* ── Insert token dropdown ── */}
        <button
          ref={btnRef}
          type="button"
          className={`rte-btn rte-insert-btn${showInsert ? ' rte-btn-on' : ''}`}
          style={{ width: 'auto', minWidth: 'fit-content', padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          onMouseDown={e => {
            e.preventDefault();
            // Editor is still focused here (preventDefault stops focus moving to button).
            // Capture selection now — this is the most reliable moment.
            saveSelection();
            console.log('INSERT CLICKED', { showInsert, savedRange: !!savedRangeRef.current });
            if (!showInsert) {
              const r = e.currentTarget.getBoundingClientRect();
              console.log('menu pos:', { top: r.bottom + 4, left: r.left });
              setMenuPos({ top: r.bottom + 4, left: r.left });
              setShowInsert(true);
            } else {
              setShowInsert(false);
              setFillInEntry(false);
              setFillInLabel('');
            }
          }}
          title="Insert dynamic field"
        >
          Insert <span className="rte-caret">▾</span>
        </button>
      </div>

      <div
        ref={editorRef}
        contentEditable
        className="rte-editor"
        onInput={notify}
        onBlur={saveSelection}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Type replacement text…"
      />

      {showInsert && menuPos && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className="rte-insert-menu"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {/* Fill-in label input — always mounted so ref is always valid,
              toggled visible/hidden via CSS to avoid React render-timing races */}
          <div
            className="rte-fillin-row"
            style={{ display: fillInEntry ? 'flex' : 'none' }}
          >
            <span className="rte-fillin-prompt-label">Field label:</span>
            <input
              ref={fillInInputRef}
              className="rte-fillin-input"
              value={fillInLabel}
              onChange={e => setFillInLabel(e.target.value)}
              placeholder="e.g. Recipient Name"
              onKeyDown={e => {
                if (e.key === 'Enter') handleInsertFillIn(e);
                if (e.key === 'Escape') { setFillInEntry(false); setFillInLabel(''); }
              }}
            />
            <button
              type="button"
              className="rte-fillin-ok"
              onMouseDown={handleInsertFillIn}
            >Insert</button>
          </div>

          {/* Menu items — hidden while fill-in label input is active */}
          <div style={{ display: fillInEntry ? 'none' : 'contents' }}>
            {INSERT_MENU.map((item, i) =>
              item.type === 'sep' ? (
                <div key={`sep-${i}`} className="rte-menu-sep" />
              ) : (
                <button
                  key={item.token}
                  type="button"
                  className="rte-menu-item"
                  onMouseDown={e => {
                    console.log('MENU ITEM CLICKED', item.token, 'fillInEntry:', fillInEntry);
                    handleInsertItem(e, item);
                  }}
                >
                  <span className={`rte-menu-chip rte-chip-${
                    item.token === '{clipboard}'   ? 'clipboard' :
                    item.token.startsWith('{date') ? 'date' :
                    item.token.startsWith('{time') ? 'date' :
                    item.token === '{dayofweek}'   ? 'date' :
                    item.token === '{cursor}'      ? 'cursor' :
                    'fillin'
                  }`}>
                    {item.display || '✎'}
                  </span>
                  {item.label}
                </button>
              )
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function TextExpansions({
  expansions,
  onAdd,
  onDelete,
  categories = [],
  onAddCategory,
  onDeleteCategory,
  // Autocorrect props
  autocorrectEnabled,
  onToggleAutocorrect,
  autocorrections = [],
  onAddAutocorrect,
  onDeleteAutocorrect,
}) {
  // ── Panel mode (expansions | autocorrect) ──
  const [panelMode, setPanelMode] = useState('expansions');

  // ── Expansion form state ──
  const [editing, setEditing]         = useState(null);
  const [trigger, setTrigger]         = useState('');
  const [displayName, setDisplayName] = useState('');
  const [editorValue, setEditorValue] = useState({ html: '', text: '' });
  const [category, setCategory]       = useState(null);
  const [triggerMode, setTriggerMode] = useState('space'); // 'space' | 'immediate'

  // ── Trigger duplicate error ──
  const [triggerError, setTriggerError] = useState('');

  // ── Category bar state ──
  const [activeCategory, setActiveCategory]   = useState('All');
  const [addingCategory, setAddingCategory]   = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [pendingDeleteCat, setPendingDeleteCat] = useState(null);
  const [deleteConfirm, setDeleteConfirm]       = useState(null); // trigger string awaiting confirmation

  // ── Autocorrect form state ──
  const [acEditing, setAcEditing]       = useState(null); // null | { isNew, originalTypo? }
  const [acTypo, setAcTypo]             = useState('');
  const [acCorrection, setAcCorrection] = useState('');

  // Reset pending-delete when clicking elsewhere
  useEffect(() => {
    if (!pendingDeleteCat) return;
    function onDown() { setPendingDeleteCat(null); }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pendingDeleteCat]);

  // If the active category is deleted, fall back to All
  useEffect(() => {
    if (activeCategory !== 'All' && !categories.includes(activeCategory)) {
      setActiveCategory('All');
    }
  }, [categories, activeCategory]);

  // ── Expansion handlers ──
  function openAdd() {
    setTrigger('');
    setDisplayName('');
    setTriggerError('');
    setEditorValue({ html: '', text: '' });
    setCategory(activeCategory === 'All' ? null : activeCategory);
    setTriggerMode('space');
    setEditing({ isNew: true });
  }

  function openEdit(exp) {
    setTrigger(exp.trigger);
    setDisplayName(exp.displayName || '');
    setTriggerError('');
    setEditorValue({ html: exp.html, text: exp.text });
    setCategory(exp.category || null);
    setTriggerMode(exp.triggerMode || 'space');
    setEditing({ isNew: false, originalTrigger: exp.trigger });
  }

  function handleSave() {
    const t = trigger.trim().toLowerCase().replace(/\s/g, '');
    if (!t || !editorValue.text.trim()) return;
    const originalTrigger = editing.isNew ? null : editing.originalTrigger;
    onAdd(t, editorValue, originalTrigger, category, triggerMode, displayName.trim() || null);
    setEditing(null);
  }

  function handleCancel() {
    setEditing(null);
  }

  function handleAddCategory(e) {
    e.preventDefault();
    const name = newCategoryName.trim();
    if (name) {
      onAddCategory(name);
      setNewCategoryName('');
    }
    setAddingCategory(false);
  }

  function handleDeleteCategoryConfirm(e, name) {
    e.stopPropagation();
    if (pendingDeleteCat === name) {
      onDeleteCategory(name);
      setPendingDeleteCat(null);
    } else {
      setPendingDeleteCat(name);
    }
  }

  // ── Autocorrect handlers ──
  function openAcAdd() {
    setAcTypo('');
    setAcCorrection('');
    setAcEditing({ isNew: true });
  }

  function openAcEdit(ac) {
    setAcTypo(ac.typo);
    setAcCorrection(ac.correction);
    setAcEditing({ isNew: false, originalTypo: ac.typo });
  }

  function handleAcSave() {
    const typo = acTypo.trim().toLowerCase().replace(/\s/g, '');
    const correction = acCorrection.trim();
    if (!typo || !correction) return;
    const originalTypo = acEditing.isNew ? null : acEditing.originalTypo;
    onAddAutocorrect?.(typo, correction, originalTypo);
    setAcEditing(null);
  }

  function handleAcCancel() {
    setAcEditing(null);
  }

  const canSave   = trigger.trim() && editorValue.text.trim() && !triggerError;
  const canAcSave = acTypo.trim() && acCorrection.trim();

  const uncategorisedCount = expansions.filter(e => !e.category).length;

  // Build flat list for the current expansion tab
  const listItems = (() => {
    const byTrigger = arr => [...arr].sort((a, b) => a.trigger.localeCompare(b.trigger));

    if (activeCategory !== 'All') {
      const pool = activeCategory === '__uncategorised__'
        ? expansions.filter(e => !e.category)
        : expansions.filter(e => e.category === activeCategory);
      return byTrigger(pool).map(exp => ({ type: 'item', exp }));
    }

    // All tab — grouped: uncategorised first, then named categories
    const result = [];
    const uncat = byTrigger(expansions.filter(e => !e.category));
    if (uncat.length > 0) {
      result.push({ type: 'header', label: 'Uncategorised', color: null, count: uncat.length });
      uncat.forEach(exp => result.push({ type: 'item', exp }));
    }
    for (const cat of categories) {
      const items = byTrigger(expansions.filter(e => e.category === cat));
      if (items.length === 0) continue;
      result.push({ type: 'header', label: cat, color: categoryColor(cat), count: items.length });
      items.forEach(exp => result.push({ type: 'item', exp }));
    }
    return result;
  })();

  // Sorted custom autocorrections
  const sortedAc = [...autocorrections].sort((a, b) => a.typo.localeCompare(b.typo));

  const itemCount = listItems.filter(x => x.type === 'item').length;

  return (
    <div className="text-expansions">

      {/* ── Header ── */}
      <div className="te-header">
        <div className="te-mode-tabs">
          <button
            className={`te-mode-tab${panelMode === 'expansions' ? ' active' : ''}`}
            onClick={() => setPanelMode('expansions')}
            type="button"
          >
            ✦ Text Expansions
          </button>
          <button
            className={`te-mode-tab${panelMode === 'autocorrect' ? ' active' : ''}`}
            onClick={() => setPanelMode('autocorrect')}
            type="button"
          >
            Autocorrect
          </button>
        </div>
        <div className="te-header-right">
          <span className="te-hint">
            {panelMode === 'expansions' ? 'type trigger + Space' : 'corrects on Space'}
          </span>
          {panelMode === 'expansions' ? (
            <button className="te-add-btn" onClick={openAdd} title="Add expansion" type="button">
              + Add
            </button>
          ) : (
            <button className="te-add-btn" onClick={openAcAdd} title="Add custom correction" type="button">
              + Add
            </button>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════ EXPANSIONS VIEW ══════════════════════════════════ */}
      {panelMode === 'expansions' && (
        <>
          {/* ── Category bar ── */}
          <div className="te-cat-bar">
            <button
              className={`te-cat-tab${activeCategory === 'All' ? ' te-cat-tab-active' : ''}`}
              onClick={() => setActiveCategory('All')}
            >
              All
              <span className="te-cat-count">{expansions.length}</span>
            </button>

            {categories.map(cat => {
              const color = categoryColor(cat);
              const isPending = pendingDeleteCat === cat;
              const count = expansions.filter(e => e.category === cat).length;
              return (
                <div key={cat} className="te-cat-tab-group">
                  <button
                    className={`te-cat-tab${activeCategory === cat ? ' te-cat-tab-active' : ''}`}
                    style={{ '--cat-color': color }}
                    onClick={() => { setActiveCategory(cat); setPendingDeleteCat(null); }}
                  >
                    <span className="te-cat-dot" style={{ background: color }} />
                    {cat}
                    <span className="te-cat-count">{count}</span>
                  </button>
                  <button
                    className={`te-cat-x${isPending ? ' te-cat-x-confirm' : ''}`}
                    onMouseDown={e => handleDeleteCategoryConfirm(e, cat)}
                    title={isPending ? 'Click to confirm delete' : `Delete "${cat}" category`}
                  >
                    {isPending ? 'Delete?' : '✕'}
                  </button>
                </div>
              );
            })}

            {expansions.length > 0 && uncategorisedCount > 0 && (
              <button
                className={`te-cat-tab te-cat-tab-uncategorised${activeCategory === '__uncategorised__' ? ' te-cat-tab-active' : ''}`}
                onClick={() => setActiveCategory('__uncategorised__')}
              >
                Uncategorised
                <span className="te-cat-count">{uncategorisedCount}</span>
              </button>
            )}

            <div className="te-cat-bar-spacer" />

            {addingCategory ? (
              <form onSubmit={handleAddCategory} className="te-cat-add-form">
                <input
                  autoFocus
                  className="te-cat-add-input"
                  value={newCategoryName}
                  onChange={e => setNewCategoryName(e.target.value)}
                  placeholder="Category name…"
                  onBlur={handleAddCategory}
                  onKeyDown={e => e.key === 'Escape' && setAddingCategory(false)}
                />
              </form>
            ) : (
              <button className="te-cat-new-btn" onClick={() => setAddingCategory(true)}>
                + Category
              </button>
            )}
          </div>

          {/* ── Body: list + edit panel side-by-side ── */}
          <div className="te-body">

            {/* Scrollable list */}
            <div className="te-list">
              {itemCount === 0 ? (
                expansions.length === 0 ? (
                  <div className="te-empty-state">
                    <span className="te-empty-icon">✦</span>
                    <span className="te-empty-heading">No text expansions yet</span>
                    <span className="te-empty-sub">Click <strong>+ Add</strong> to create your first expansion. Type a short trigger word and it expands to full text instantly anywhere on your computer.</span>
                    <span className="te-empty-example">e.g. type <kbd className="te-empty-kbd">signoff</kbd> and press Space → <em>"Thanks for your message, speak soon!"</em></span>
                  </div>
                ) : (
                  <div className="te-empty-row">No expansions in this category yet</div>
                )
              ) : (
                listItems.map((item, i) => {
                  if (item.type === 'header') {
                    return (
                      <div key={`h-${item.label}`} className="te-group-header">
                        {item.color && <span className="te-group-dot" style={{ background: item.color }} />}
                        <span className="te-group-name">{item.label.toUpperCase()}</span>
                        <span className="te-group-count">{item.count}</span>
                        <span className="te-group-rule" />
                      </div>
                    );
                  }
                  const { exp } = item;
                  const color = exp.category ? categoryColor(exp.category) : null;
                  const isEditingThis = editing && !editing.isNew && editing.originalTrigger === exp.trigger;
                  return (
                    <div
                      key={exp.trigger}
                      className={`te-item${isEditingThis ? ' te-item-editing' : ''}`}
                      onClick={() => openEdit(exp)}
                    >
                      <span className="te-item-name">{exp.displayName || exp.trigger}</span>
                      <kbd className="te-trigger-badge">{exp.trigger}</kbd>
                      {exp.triggerMode === 'immediate' && (
                        <span className="te-immediate-badge" title="Fires instantly (no Space needed)">⚡</span>
                      )}
                      {exp.category && activeCategory === 'All' && (
                        <span
                          className="te-cat-badge"
                          style={{ '--cat-color': color }}
                          title={exp.category}
                        >
                          {exp.category}
                        </span>
                      )}
                      <span className="te-item-arrow">→</span>
                      <span className="te-replacement">{exp.text}</span>
                      <div className="te-item-actions">
                        <button
                          className="te-item-delete"
                          onClick={e => { e.stopPropagation(); setDeleteConfirm(exp.trigger); }}
                          type="button"
                          title="Delete expansion"
                        >✕</button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Right edit panel — always visible */}
            <div className="te-edit-panel">
              {editing ? (
                <>
                  <div className="te-panel-header">
                    <span className="te-panel-title">
                      {editing.isNew ? 'New Expansion' : 'Edit Expansion'}
                    </span>
                    <button className="te-panel-close" onClick={handleCancel} type="button">✕</button>
                  </div>

                  {/* Fixed-height top fields: name + trigger + mode + category */}
                  <div className="te-panel-fields">
                    <div className="te-panel-field">
                      <label className="form-label">NAME <span className="te-optional-label">(OPTIONAL)</span></label>
                      <input
                        className="form-input"
                        placeholder="e.g. Email sign-off, CAD polyline command…"
                        value={displayName}
                        onChange={e => setDisplayName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') handleCancel(); }}
                        autoFocus
                        spellCheck={false}
                      />
                    </div>
                    <div className="te-panel-field">
                      <label className="form-label">TRIGGER</label>
                      <input
                        className={`form-input te-trigger-input${triggerError ? ' te-input-error' : ''}`}
                        placeholder="brb"
                        value={trigger}
                        onChange={e => {
                          const val = e.target.value.replace(/\s/g, '');
                          setTrigger(val);
                          const normalized = val.trim().toLowerCase();
                          if (normalized) {
                            const clash = expansions.find(exp =>
                              exp.trigger.toLowerCase() === normalized &&
                              (editing?.isNew || exp.trigger.toLowerCase() !== editing?.originalTrigger?.toLowerCase())
                            );
                            if (clash) {
                              setTriggerError(`This trigger is already in use by "${clash.displayName || clash.trigger}". Delete or rename that expansion first.`);
                            } else {
                              setTriggerError('');
                            }
                          } else {
                            setTriggerError('');
                          }
                        }}
                        onKeyDown={e => { if (e.key === 'Escape') handleCancel(); }}
                        spellCheck={false}
                      />
                      {triggerError && <span className="te-trigger-error">{triggerError}</span>}
                    </div>
                    <div className="te-trigger-mode">
                      <button
                        type="button"
                        className={`te-trigger-mode-btn${triggerMode === 'space' ? ' active' : ''}`}
                        onClick={() => setTriggerMode('space')}
                        title="Fire after Space is pressed"
                      >+ Space</button>
                      <button
                        type="button"
                        className={`te-trigger-mode-btn${triggerMode === 'immediate' ? ' active' : ''}`}
                        onClick={() => setTriggerMode('immediate')}
                        title="Fire immediately when trigger is typed"
                      >⚡ Instant</button>
                    </div>
                    <div className="te-panel-field">
                      <label className="form-label">CATEGORY</label>
                      <select
                        className="te-cat-select"
                        value={category || ''}
                        onChange={e => setCategory(e.target.value || null)}
                      >
                        <option value="">Uncategorised</option>
                        {categories.map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* RTE fills remaining vertical space */}
                  <div className="te-panel-rte">
                    <label className="form-label">REPLACEMENT</label>
                    <RichTextEditor
                      key={editing.isNew ? '__new__' : editing.originalTrigger}
                      initialHtml={editorValue.html}
                      onChange={setEditorValue}
                    />
                  </div>

                  <div className="te-panel-footer">
                    <span className="te-paste-note">Pastes as plain text</span>
                    <div className="te-form-actions">
                      <button className="te-cancel-btn" onClick={handleCancel} type="button">Cancel</button>
                      <button className="te-save-btn" onClick={handleSave} disabled={!canSave} type="button">
                        Save
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="te-panel-idle">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                  </svg>
                  <p>Select an expansion to edit,<br/>or click <strong>+ Add</strong> to create a new one</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ════════════════════════════════════ AUTOCORRECT VIEW ═════════════════════════════════ */}
      {panelMode === 'autocorrect' && (
        <div className="ac-view">

          {/* ── Built-in library toggle ── */}
          <div className="ac-builtin-row">
            <div className="ac-builtin-info">
              <span className="ac-builtin-label">Built-in corrections</span>
              <span className="ac-builtin-sub">50 common typos — teh→the, recieve→receive, definately→definitely…</span>
            </div>
            <button
              className={`ac-toggle${autocorrectEnabled ? ' ac-toggle-on' : ''}`}
              onClick={onToggleAutocorrect}
              type="button"
              role="switch"
              aria-checked={autocorrectEnabled}
              title={autocorrectEnabled ? 'Disable built-in corrections' : 'Enable built-in corrections'}
            />
          </div>

          {/* ── Custom corrections ── */}
          <div className="ac-section-header">
            <span>Custom Corrections</span>
            <span className="ac-section-count">{autocorrections.length}</span>
          </div>

          {/* Add / Edit form */}
          {acEditing && (
            <div className="ac-form">
              <div className="ac-form-fields">
                <div className="ac-form-col">
                  <label className="form-label">TYPO</label>
                  <input
                    className="form-input ac-field-input"
                    placeholder="recieve"
                    value={acTypo}
                    onChange={e => setAcTypo(e.target.value.replace(/\s/g, ''))}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') handleAcCancel(); }}
                    autoFocus
                    spellCheck={false}
                  />
                </div>
                <div className="ac-form-arrow">→</div>
                <div className="ac-form-col">
                  <label className="form-label">CORRECTION</label>
                  <input
                    className="form-input ac-field-input"
                    placeholder="receive"
                    value={acCorrection}
                    onChange={e => setAcCorrection(e.target.value)}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') handleAcSave(); if (e.key === 'Escape') handleAcCancel(); }}
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="ac-form-footer">
                <button className="te-cancel-btn" onClick={handleAcCancel} type="button">Cancel</button>
                <button className="te-save-btn" onClick={handleAcSave} disabled={!canAcSave} type="button">
                  Save
                </button>
              </div>
            </div>
          )}

          {/* Custom corrections list */}
          {sortedAc.length === 0 && !acEditing ? (
            <div className="te-empty-row">
              No custom corrections yet — add your own typo→correction pairs above
            </div>
          ) : (
            <div className="ac-list">
              {sortedAc.map(ac => (
                <div key={ac.typo} className="ac-item">
                  <kbd className="te-trigger-badge ac-typo-badge">{ac.typo}</kbd>
                  <span className="te-item-arrow">→</span>
                  <span className="ac-correction">{ac.correction}</span>
                  <div className="te-item-actions">
                    <button className="te-item-edit" onClick={() => openAcEdit(ac)} type="button">Edit</button>
                    <button className="te-item-delete" onClick={() => onDeleteAutocorrect?.(ac.typo)} type="button">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="te-delete-overlay">
          <div className="te-delete-dialog">
            <div className="te-delete-title">Delete Expansion</div>
            <p className="te-delete-body">
              Delete <kbd className="te-trigger-badge">{deleteConfirm}</kbd>? This cannot be undone.
            </p>
            <div className="te-delete-actions">
              <button className="te-cancel-btn" onClick={() => setDeleteConfirm(null)} type="button">
                Cancel
              </button>
              <button
                className="te-delete-confirm-btn"
                onClick={() => {
                  onDelete(deleteConfirm);
                  if (editing && !editing.isNew && editing.originalTrigger === deleteConfirm) {
                    setEditing(null);
                  }
                  setDeleteConfirm(null);
                }}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
