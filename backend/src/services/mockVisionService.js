export function recognizeProduct({ images = [] } = {}) {
  const productInfoRaw = {
    sku: `SKU-${Date.now()}`,
    name: 'Insulated Stainless Steel Water Bottle',
    category: 'Drinkware',
    color: 'Sky Blue',
    dimensions: '9.8 x 2.9 in',
    capacity: '24 oz',
    material: 'BPA-free stainless steel',
    packageList: ['1 insulated bottle', '1 leak-proof lid', '1 cleaning brush', '1 retail box'],
    imageText: ['24 OZ', 'KEEP COLD 24H'],
    sellingPoints: [
      'Double-wall vacuum insulation',
      'Leak-proof lid for travel',
      'Slim cup-holder friendly shape',
      'Durable powder-coated finish'
    ],
    riskItems: ['Avoid medical claims', 'Do not show competitor logos', 'No unsupported certification badges'],
    language: 'English',
    notes: images.length > 1 ? [`Mock recognition used ${images.length} source images.`] : []
  };

  return {
    productInfoRaw,
    visibleText: productInfoRaw.imageText,
    risks: productInfoRaw.riskItems,
    confidence: {
      name: 0.94,
      category: 0.88,
      color: 0.9,
      dimensions: 0.72,
      capacity: 0.76,
      material: 0.68
    },
    notes: productInfoRaw.notes
  };
}
