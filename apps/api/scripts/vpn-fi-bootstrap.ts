import {
  readVpnFiBootstrapInput,
  runVpnFiBootstrap,
} from '../src/orchestration/vpn-fi-bootstrap';

void runVpnFiBootstrap(readVpnFiBootstrapInput(process.env)).catch(
  (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'vpn-fi bootstrap failed';
    console.error(message);
    process.exitCode = 1;
  },
);
