import {
  readVpnEuBootstrapInput,
  runVpnEuBootstrap,
} from '../src/orchestration/vpn-eu-bootstrap';

void runVpnEuBootstrap(readVpnEuBootstrapInput(process.env)).catch(
  (error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'vpn-eu bootstrap failed';
    console.error(message);
    process.exitCode = 1;
  },
);
