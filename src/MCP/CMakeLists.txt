# ============================================================================
# MCP Module
# Local Model Context Protocol server so AI assistants can read vehicle state and propose parameter changes
# that the user approves in QGC, plus the stdio bridge used by desktop assistant apps.
# ============================================================================

target_sources(${CMAKE_PROJECT_NAME}
    PRIVATE
        QGCMcpProposal.cc
        QGCMcpProposal.h
        QGCMcpServer.cc
        QGCMcpServer.h
        QGCMcpStdioBridge.cc
        QGCMcpStdioBridge.h
)

target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
