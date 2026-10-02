// Photos in the notes box (GATE_NOTE_BOX_PHOTOS, owner "ok go" 2026-10-02 on
// the Fast Complete mockup v8, call 10): the visit's photos sit inside the
// notes box, each with a short description the tech types or says. A
// description is the photo's caption: it goes to the report writer with the
// notes and prints under the photo on the customer's report. The AI photo
// read ("Describe with AI") and its summary live here too, so the separate
// photo section goes away.
import React, { useState } from 'react';
import { Camera, Mic, MicOff } from 'lucide-react';
import useSpeechDictation from '../../hooks/useSpeechDictation';

export const PHOTO_CAPTION_MAX_CHARS = 200;

export default function NoteBoxPhotos({
  photos,
  max,
  disabled,
  palette,
  dictationServiceId,
  onAdd,
  onRemove,
  onCaption,
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
  const [session, setSession] = useState(0);
  const open = (index) => {
    if (disabled) return;
    setEditing(index);
    setSession((n) => n + 1);
  };
  const close = () => setEditing(null);
  const editingPhoto = editing != null ? photos[editing] : null;
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
              key={photo.data ? `${index}-${photo.name}` : index}
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
          palette={palette}
          button={button}
          dictationServiceId={dictationServiceId}
          onSave={(caption) => {
            onCaption(editing, caption);
            close();
          }}
          onCancel={close}
        />
      )}

      <PhotoActions
        count={photos.length}
        max={max}
        disabled={disabled}
        editing={editing != null}
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
function CaptionEditor({ index, initial, disabled, palette, button, dictationServiceId, onSave, onCancel }) {
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
    <div style={{ display: 'grid', gap: 8 }} data-modal-escape-owned="true">
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
              if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
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
              disabled={disabled || dictation.uploading}
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
          src={photo.data}
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
function PhotoActions({ count, max, disabled, editing, button, palette, onAdd, onDescribeWithAi, describing }) {
  const addOff = disabled || count >= max;
  const describeOff = disabled || describing;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <button type="button" onClick={onAdd} disabled={addOff} style={{ ...button, opacity: addOff ? 0.5 : 1 }}>
        <Camera size={15} strokeWidth={2.2} aria-hidden="true" />
        {count ? `Add photo (${count}/${max})` : 'Add photo'}
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
