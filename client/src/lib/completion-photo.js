// client/src/lib/completion-photo.js
//
// Prepares a camera/file photo for the /complete endpoint's completionPhotos:
// a canvas downscale to at most 1600 px on the long side, re-encoded as JPEG
// at the first quality that fits 1.5 MB (the server caps a completion photo's
// data URL). Shared by the full completion form (pages/admin/SchedulePage.jsx)
// and the Tree & Shrub Fast Complete sheet.
const COMPLETION_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const COMPLETION_PHOTO_MAX_DIMENSION = 1600;
const COMPLETION_PHOTO_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.54];

function dataUrlApproxBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",")[1] || "";
  return Math.ceil((encoded.length * 3) / 4);
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read photo"));
    };
    img.src = url;
  });
}

export async function prepareCompletionPhoto(file) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error("Only image files can be attached.");
  }
  const image = await loadImageFromFile(file);
  const largestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
  let scale = largestSide > COMPLETION_PHOTO_MAX_DIMENSION
    ? COMPLETION_PHOTO_MAX_DIMENSION / largestSide
    : 1;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, width, height);

    for (const quality of COMPLETION_PHOTO_QUALITY_STEPS) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlApproxBytes(data) <= COMPLETION_PHOTO_MAX_BYTES) {
        return {
          data,
          name: file.name?.replace(/\.[^.]+$/, ".jpg") || "service-photo.jpg",
          capturedAt: new Date().toISOString(),
        };
      }
    }
    scale *= 0.75;
  }
  throw new Error("Photo is too large to attach to completion.");
}
