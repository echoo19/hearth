/**
 * Choosing a cover, from the images the game already has.
 *
 * There is no native file picker in this app — `hearthNative` opens folders,
 * not files — and a cover pulled from somewhere else on the disk would be a
 * file the project does not contain, which is a different and larger promise
 * than "publish this folder". So the choice is over the images already in the
 * folder, which is also the honest shape of `coverPath` on the wire: a path
 * inside the project.
 *
 * A select rather than a grid of thumbnails: the list is a handful of names, a
 * grid of them would be six cards to say one sentence, and the one thing a
 * grid buys — seeing the picture — is bought here by showing the picture that
 * was actually chosen, at the size it will be seen.
 *
 * Three honest states, and they are not the same state:
 *   looking  — we have not read the folder yet, so we say nothing about it
 *   none     — read it, and there are no images in it
 *   list     — here they are
 * Collapsing the first into the second is the specific lie this app cares
 * most about: "there is nothing" when the truth is "we have not looked".
 */
import React, { useEffect, useState } from 'react';
import { apiListFiles, projectFileUrl } from '../../api';
import { imageFiles } from './publishDraft';

export function CoverField({
  id,
  project,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  project: string;
  /** Project-relative path, or '' for no cover. */
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const [images, setImages] = useState<string[] | null>(null);
  // A cover that 404s renders as a broken-image glyph, which looks like the
  // app is broken rather than like the file moved. Tracked so the frame can
  // say what happened instead.
  const [brokenPreview, setBrokenPreview] = useState(false);

  useEffect(() => {
    let live = true;
    setImages(null);
    void apiListFiles(project).then((files) => {
      if (!live) return;
      setImages(imageFiles(files.map((file) => file.path)));
    });
    return () => {
      live = false;
    };
  }, [project]);

  useEffect(() => {
    setBrokenPreview(false);
  }, [value]);

  if (images === null) {
    return (
      <p className="publish-note" id={id}>
        Looking for images in the folder…
      </p>
    );
  }

  if (images.length === 0) {
    return (
      <p className="publish-note" id={id}>
        No images in this folder yet. A cover is optional; add a PNG or JPG to the project and it will show up here.
      </p>
    );
  }

  return (
    <div className="publish-cover">
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">No cover</option>
        {images.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
      {value !== '' && (
        <div className="publish-cover-preview">
          {brokenPreview ? (
            <p className="publish-note">That image could not be loaded from the folder.</p>
          ) : (
            <img
              src={projectFileUrl(project, value)}
              alt={`Cover preview: ${value}`}
              onError={() => setBrokenPreview(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}
