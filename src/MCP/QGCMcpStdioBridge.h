#pragma once

/// Runs QGroundControl as a tiny stdio <-> HTTP relay ("QGroundControl --mcp-bridge").
///
/// Desktop AI apps such as Claude launch local MCP servers as a child process and talk JSON-RPC over stdin/stdout.
/// This mode forwards each message to the MCP endpoint of the already running QGroundControl window, so no extra
/// runtime (Node, Python) is needed. It never starts the GUI.
namespace QGCMcpStdioBridge {

/// True when argv asks for bridge mode.
bool requested(int argc, char *argv[]);

/// Runs the bridge until stdin closes; returns the process exit code.
int run(int argc, char *argv[]);

} // namespace QGCMcpStdioBridge
