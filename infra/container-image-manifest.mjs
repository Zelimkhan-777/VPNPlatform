export const applicationImages = [
  { name: 'api', reference: 'vpn-platform/api:ci' },
  { name: 'worker', reference: 'vpn-platform/worker:ci' },
  { name: 'bot', reference: 'vpn-platform/bot:ci' },
  { name: 'web', reference: 'vpn-platform/web:ci' },
];

export const applicationImageBuildIdLabel = 'com.vpn-platform.image-build-id';
export const applicationImageRevisionLabel =
  'org.opencontainers.image.revision';
export const applicationImageSourceStateLabel = 'com.vpn-platform.source-state';
export const applicationImageSourceHeadLabel = 'com.vpn-platform.source-head';
export const applicationImageSourceFingerprintLabel =
  'com.vpn-platform.source-fingerprint';
export const applicationImageBuildReceiptUrl = new URL(
  '../var/container-images/build-receipt.json',
  import.meta.url,
);
