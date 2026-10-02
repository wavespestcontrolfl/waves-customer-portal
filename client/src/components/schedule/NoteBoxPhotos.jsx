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
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const dictation = useSpeechDictation(
    (text) => setDraft((prev) => (prev ? `${prev} ${text}` : text).slice(0, PHOTO_CAPTION_MAX_CHARS)),
    { uploadServiceId: dictationServiceId },
  );
  const open = (index) => {
    if (disabled) return;
    setEditing(index);
    setDraft(photos[index]?.caption || '');
  };
  const close = () => {
    if (dictation.listening) dictation.cancel?.();
    setEditing(null);
    setDraft('');
  };
  const save = () => {
    onCaption(editing, draft.trim());
    close();
  };
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
            <div key={photo.data ? `${index}-${photo.name}` : index} style={{ position: 'relative', width: 112 }}>
              <button
                type="button"
                onClick={() => open(index)}
                disabled={disabled}
                aria-label={`Describe photo ${index + 1}`}
                style={{ display: 'block', padding: 0, border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', width: '100%', textAlign: 'left' }}
              >
                <img
                  src={photo.data}
                  alt={photo.caption || photo.name || `Photo ${index + 1}`}
                  style={{ width: 112, aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 8, border: `1px solid ${palette.border}`, display: 'block' }}
                />
                <span
                  style={{
                    display: 'block',
                    marginTop: 4,
                    fontSize: 14,
                    lineHeight: 1.3,
                    color: photo.caption ? palette.text : palette.muted,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {photo.caption || 'Add a description'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (editing === index) close();
                  onRemove(index);
                }}
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
          ))}
        </div>
      )}

      {editingPhoto && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 14, color: palette.text }}>
            {`Description for photo ${editing + 1}`}
            <span style={{ position: 'relative', display: 'block' }}>
              <input
                value={draft}
                maxLength={PHOTO_CAPTION_MAX_CHARS}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); save(); }
                  if (e.key === 'Escape') { e.preventDefault(); close(); }
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
                  disabled={dictation.uploading}
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
            <button type="button" onClick={save} style={{ ...button, cursor: 'pointer', opacity: 1, background: palette.text, color: palette.card, borderColor: palette.text }}>
              Save description
            </button>
            <button type="button" onClick={close} style={{ ...button, cursor: 'pointer', opacity: 1 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={onAdd}
          disabled={disabled || photos.length >= max}
          style={{ ...button, opacity: disabled || photos.length >= max ? 0.5 : 1 }}
        >
          <Camera size={15} strokeWidth={2.2} aria-hidden="true" />
          {`Add photo${photos.length ? ` (${photos.length}/${max})` : ''}`}
        </button>
        {photos.length > 0 && onDescribeWithAi && (
          <button
            type="button"
            onClick={onDescribeWithAi}
            disabled={disabled || describing}
            style={{ ...button, opacity: disabled || describing ? 0.5 : 1, cursor: describing ? 'wait' : button.cursor }}
          >
            {describing ? 'Describing…' : 'Describe with AI'}
          </button>
        )}
        {photos.length > 0 && editing == null && (
          <span style={{ fontSize: 14, color: palette.muted }}>Tap a photo to describe it</span>
        )}
      </div>
      {describeError && <div style={{ fontSize: 14, color: palette.danger }}>{describeError}</div>}

      {summary !== '' && onSummary && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: palette.text }}>{summaryLabel}</div>
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
          {onAddSummaryToNotes && (
            <div>
              <button
                type="button"
                onClick={onAddSummaryToNotes}
                disabled={disabled || !summary.trim()}
                style={{ ...button, opacity: disabled || !summary.trim() ? 0.5 : 1 }}
              >
                Add to technician notes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
