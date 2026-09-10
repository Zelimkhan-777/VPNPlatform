import {
  readVpnPlBootstrapInput,
  runVpnPlBootstrap,
} from '../src/orchestration/vpn-pl-bootstrap';

void runVpnPlBootstrap(readVpnPlBootstrapInput(process.env)).catch(
  (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'vpn-pl bootstrap failed';
    console.error(message);
    process.exitCode = 1;
  },
);
