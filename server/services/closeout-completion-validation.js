function usableProductRows(products, { validProductIds = null } = {}) {
  if (!Array.isArray(products)) return [];
  return products.filter((product) => (
    product
    && typeof product === 'object'
    && product.productId
    && (!validProductIds || validProductIds.has(String(product.productId)))
  ));
}

function validateCloseoutCompletionRequirements(requirements = {}, payload = {}, options = {}) {
  const violations = [];
  const requiredPhotoCount = Number(requirements.requiredPhotoCount || 0);
  const completionPhotos = Array.isArray(payload.completionPhotos) ? payload.completionPhotos : [];

  if (requiredPhotoCount > 0 && completionPhotos.length < requiredPhotoCount) {
    violations.push({
      type: 'missing_required_photos',
      label: 'Missing required photos',
      required: requiredPhotoCount,
      actual: completionPhotos.length,
      message: `This service requires ${requiredPhotoCount} closeout photo${requiredPhotoCount === 1 ? '' : 's'} before completion.`,
    });
  }

  const productRows = usableProductRows(payload.products, options);
  if (requirements.requiresApplicationLog && productRows.length === 0) {
    violations.push({
      type: 'missing_required_material_log',
      label: 'Missing required material log',
      required: true,
      actual: false,
      message: 'This service requires at least one application/material entry before completion.',
    });
  }

  return violations;
}

module.exports = {
  usableProductRows,
  validateCloseoutCompletionRequirements,
};
