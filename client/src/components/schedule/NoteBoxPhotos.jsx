// Photos in the notes box (GATE_NOTE_BOX_PHOTOS, owner "ok go" 2026-10-02 on
// the Fast Complete mockup v8, call 10): the visit's photos sit inside the
// notes box, each with a short description the tech types or says. A
// description is the photo's caption: it goes to the report writer with the
// notes and prints under the photo on the customer's report. The AI photo
// read ("Describe with AI") and its summary live here too, so the separate
// photo section goes away. The tech's Fast Complete sheet uses it too
// (FastCompleteReport.jsx TechNoteBoxPhotos), for photos already staged on
// the visit: those carry an id and a URL instead of data, may have no limit,
// and save a description on the server (onCaption answers a promise; the
// editor closes once it resolves true and stays open with the words
// otherwise).
import React, { useEffect, useState } from 'react';
import { Camera, Mic, MicOff } from 'lucide-react';
import useSpeechDictation from '../../hooks/useSpeechDictation';

export const PHOTO_CAPTION_MAX_CHARS = 200;

// A photo's identity: a staged photo's id, else the office form's data URL.
const photoKey = (photo) => (photo ? (photo.id ?? photo.data ?? null) : null);

export default function NoteBoxPhotos({
  photos,
  max,
  disabled,
  palette,
  dictationServiceId,
  addLockedWhileEditing = false,
  onAdd,
  onRemove,
  onCaption,
  onEditingChange,
  micBusy = false,
  onDescribeWithAi,
  describing,
  describeError,
  summary,
  summaryLabel,
  onSummary,
  onAddSummaryToNotes,
}) {
  // The open description: which photo, and a session count that remounts
  // its editor (and the editor's own mic) for every photo opened.
  const [editing, setEditing] = useState(null);
  const [editingKey, setEditingKey] = useState(null);
  const [session, setSession] = useState(0);
  const open = (index) => {
    if (disabled) return;
    setEditing(index);
    setEditingKey(photoKey(photos[index]));
    setSession((n) => n + 1);
  };
  const close = () => setEditing(null);
  // A restored or discarded draft can replace the photos under an open
  // description: it closes rather than save onto, or wait on, a photo it was
  // not opened for (codex local r3 on #5589).
  const isOpen = editing != null && photos[editing] != null && photoKey(photos[editing]) === editingKey;
  useEffect(() => {
    if (editing != null && !isOpen) setEditing(null);
  }, [editing, isOpen]);
  const editingPhoto = isOpen ? photos[editing] : null;
  // The form holds Generate and Complete while a description is open: it may
  // carry typed or dictated words not yet on the photo.
  useEffect(() => {
    onEditingChange?.(isOpen);
  }, [isOpen, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const button = {
    background: 'transparent',
    color: palette.text,
    border: `1px solid ${palette.border}`,
    borderRadius: 999,
    padding: '8px 14px',
    fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    opacity: disabled ? 0.5 : 1,
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: '10px 12px 12px', borderTop: `1px solid ${palette.border}` }}>
      {photos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {photos.map((photo, index) => (
            <PhotoThumb
              key={photo.id ?? (photo.data ? `${index}-${photo.name}` : index)}
              photo={photo}
              index={index}
              disabled={disabled}
              palette={palette}
              onOpen={() => open(index)}
              onRemove={() => {
                // Removing any photo shifts the ones after it, so an open
                // editor closes rather than save onto the wrong photo.
                close();
                onRemove(index);
              }}
            />
          ))}
        </div>
      )}

      {editingPhoto && (
        <CaptionEditor
          key={session}
          index={editing}
          initial={editingPhoto.caption || ''}
          disabled={disabled}
          micBusy={micBusy}
          palette={palette}
          button={button}
          dictationServiceId={dictationServiceId}
          onSave={(caption) => {
            const saved = onCaption(editing, caption);
            if (saved && typeof saved.then === 'function') {
              saved.then((ok) => { if (ok) close(); });
            } else {
              close();
            }
          }}
          onCancel={close}
        />
      )}

      <PhotoActions
        count={photos.length}
        max={max}
        disabled={disabled}
        editing={editing != null}
        addLocked={addLockedWhileEditing && editing != null}
        button={button}
        palette={palette}
        onAdd={onAdd}
        onDescribeWithAi={onDescribeWithAi}
        describing={describing}
      />
      {describeError && <div style={{ fontSize: 14, color: palette.danger }}>{describeError}</div>}

      {summary !== '' && onSummary && (
        <PhotoSummary
          summary={summary}
          label={summaryLabel}
          disabled={disabled}
          palette={palette}
          button={button}
          onSummary={onSummary}
          onAddToNotes={onAddSummaryToNotes}
        />
      )}
    </div>
  );
}

// One photo's description, with its own mic: the editor mounts for that
// photo and unmounts when it closes or another photo opens, so the
// dictation hook's own unmount ends the session. A recording stops without
// uploading, a microphone still asking for permission is released, and a
// transcript in flight never reaches another photo.
// While the form is busy (a report being written from these captions) the
// editor locks: nothing changes a caption the report request already read.
// `micBusy`: the notes mic is recording or transcribing, and one microphone
// records at a time (an upload recording would hear both).
function CaptionEditor({ index, initial, disabled, micBusy, palette, button, dictationServiceId, onSave, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const dictation = useSpeechDictation(
    (text) => setDraft((prev) => (prev ? `${prev} ${text}` : text).slice(0, PHOTO_CAPTION_MAX_CHARS)),
    { uploadServiceId: dictationServiceId },
  );
  // A dictation still opening, recording or transcribing has words on the
  // way: Save waits for them, so a caption never closes on what was said.
  const hearing = dictation.starting || dictation.listening || dictation.uploading;
  const saveOff = disabled || hearing;
  const save = () => {
    if (!saveOff) onSave(draft.trim());
  };
  // Escape cancels the description, never the form around it
  // (useModalFocus leaves an owned Escape to its owner).
  return (
    <div
      style={{ display: 'grid', gap: 8 }}
      data-modal-escape-owned="true"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
    >
      <label style={{ display: 'grid', gap: 4, fontSize: 14, color: palette.text }}>
        {`Description for photo ${index + 1}`}
        <span style={{ position: 'relative', display: 'block' }}>
          <input
            value={draft}
            disabled={disabled}
            maxLength={PHOTO_CAPTION_MAX_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save(); }
            }}
            placeholder={dictation.listening ? 'Listening… say what the photo shows' : 'What the photo shows, in a few words'}
            autoFocus
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: palette.card,
              color: palette.text,
              border: `1px solid ${palette.border}`,
              borderRadius: 8,
              padding: '10px 12px',
              paddingRight: dictation.supported ? 48 : 12,
              fontSize: 14,
            }}
          />
          {dictation.supported && (
            <button
              type="button"
              onClick={dictation.toggle}
              disabled={disabled || dictation.uploading || (micBusy && !dictation.listening)}
              aria-label={dictation.listening ? 'Stop describing by voice' : 'Describe by voice'}
              style={{
                position: 'absolute',
                top: '50%',
                right: 6,
                transform: 'translateY(-50%)',
                width: 36,
                height: 36,
                borderRadius: '50%',
                border: `1px solid ${dictation.listening ? palette.danger : palette.border}`,
                background: dictation.listening ? palette.danger : palette.card,
                color: dictation.listening ? palette.onDanger : palette.text,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {dictation.listening ? <MicOff size={15} strokeWidth={2.2} /> : <Mic size={15} strokeWidth={2.2} />}
            </button>
          )}
        </span>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={save} disabled={saveOff} style={{ ...button, opacity: saveOff ? 0.5 : 1, background: palette.text, color: palette.card, borderColor: palette.text }}>
          {dictation.uploading ? 'Transcribing…' : 'Save description'}
        </button>
        <button type="button" onClick={onCancel} style={{ ...button, cursor: 'pointer', opacity: 1 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// One photo in the notes box: tap it to describe it; × removes it.
function PhotoThumb({ photo, index, disabled, palette, onOpen, onRemove }) {
  const caption = photo.caption || '';
  return (
    <div style={{ position: 'relative', width: 112 }}>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={`Describe photo ${index + 1}`}
        style={{ display: 'block', padding: 0, border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', width: '100%', textAlign: 'left' }}
      >
        <img
          src={photo.data || photo.url}
          alt={caption || photo.name || `Photo ${index + 1}`}
          style={{ width: 112, aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 8, border: `1px solid ${palette.border}`, display: 'block' }}
        />
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 14,
            lineHeight: 1.3,
            color: caption ? palette.text : palette.muted,
            overflowWrap: 'anywhere',
          }}
        >
          {caption || 'Add a description'}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove photo ${index + 1}`}
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: palette.text,
          color: palette.card,
          border: 'none',
          fontSize: 14,
          lineHeight: 1,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ×
      </button>
    </div>
  );
}

// The AI photo read's summary, reviewed in place ("Add to technician
// notes" on an untyped visit; a typed visit's summary goes on the report).
function PhotoSummary({ summary, label, disabled, palette, button, onSummary, onAddToNotes }) {
  const empty = !summary.trim();
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: palette.text }}>{label}</div>
      <textarea
        value={summary}
        onChange={(e) => onSummary(e.target.value)}
        rows={3}
        maxLength={600}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          background: palette.card,
          color: palette.text,
          border: `1px solid ${palette.border}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 14,
          resize: 'vertical',
        }}
      />
      {onAddToNotes && (
        <div>
          <button
            type="button"
            onClick={onAddToNotes}
            disabled={disabled || empty}
            style={{ ...button, opacity: disabled || empty ? 0.5 : 1 }}
          >
            Add to technician notes
          </button>
        </div>
      )}
    </div>
  );
}

// The notes box's photo actions: Add photo (up to the visit's limit),
// "Describe with AI" once there are photos, and the tap-to-describe hint.
function PhotoActions({ count, max, disabled, editing, addLocked, button, palette, onAdd, onDescribeWithAi, describing }) {
  const limited = Number.isFinite(max);
  const addOff = disabled || addLocked || (limited && count >= max);
  const describeOff = disabled || describing;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <button type="button" onClick={onAdd} disabled={addOff} style={{ ...button, opacity: addOff ? 0.5 : 1 }}>
        <Camera size={15} strokeWidth={2.2} aria-hidden="true" />
        {count && limited ? `Add photo (${count}/${max})` : 'Add photo'}
      </button>
      {count > 0 && onDescribeWithAi && (
        <button
          type="button"
          onClick={onDescribeWithAi}
          disabled={describeOff}
          style={{ ...button, opacity: describeOff ? 0.5 : 1, cursor: describing ? 'wait' : button.cursor }}
        >
          {describing ? 'Describing…' : 'Describe with AI'}
        </button>
      )}
      {count > 0 && !editing && <span style={{ fontSize: 14, color: palette.muted }}>Tap a photo to describe it</span>}
    </div>
  );
}
