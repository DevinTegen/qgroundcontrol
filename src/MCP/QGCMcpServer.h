#pragma once

#include <QtCore/QJsonArray>
#include <QtCore/QJsonObject>
#include <QtCore/QObject>
#include <QtCore/QPointer>
#include <QtCore/QVector>
#include <QtQmlIntegration/QtQmlIntegration>

#include "QmlObjectListModel.h"

class QHttpServer;
class QHttpServerRequest;
class QTcpServer;
class Fact;
class Vehicle;
class QGCMcpProposal;

/// Local Model Context Protocol server so an AI assistant (e.g. the Claude desktop app, using the user's own
/// subscription) can read vehicle state and parameters and *propose* parameter changes. Proposals are shown in
/// QGC and only written to the vehicle after the user approves them. Listens on 127.0.0.1 only.
class QGCMcpServer : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Singleton")
    Q_MOC_INCLUDE("QGCMcpProposal.h")

    Q_PROPERTY(bool                 running         READ running        NOTIFY runningChanged)
    Q_PROPERTY(bool                 enabled         READ enabled        WRITE setEnabled    NOTIFY enabledChanged)
    Q_PROPERTY(int                  port            READ port           NOTIFY runningChanged)
    Q_PROPERTY(QString              endpointUrl     READ endpointUrl    NOTIFY runningChanged)
    Q_PROPERTY(QString              errorString     READ errorString    NOTIFY runningChanged)
    Q_PROPERTY(QString              bridgeCommand   READ bridgeCommand  CONSTANT)
    Q_PROPERTY(QString              desktopConfig   READ desktopConfig  CONSTANT)
    Q_PROPERTY(QmlObjectListModel*  proposals       READ proposals      CONSTANT)
    Q_PROPERTY(int                  clientRequests  READ clientRequests NOTIFY clientRequestsChanged)

public:
    explicit QGCMcpServer(QObject *parent = nullptr);
    ~QGCMcpServer() override;

    static QGCMcpServer *instance();

    static constexpr quint16 kDefaultPort = 5799;

    void init();

    bool running() const;
    bool enabled() const { return _enabled; }
    void setEnabled(bool enabled);
    int port() const { return _port; }
    QString endpointUrl() const;
    QString errorString() const { return _errorString; }
    QString bridgeCommand() const;
    QString desktopConfig() const;
    QmlObjectListModel *proposals() { return &_proposals; }
    int clientRequests() const { return _clientRequests; }

    /// Handles one JSON-RPC message (object) and returns the response; an empty object means "no response".
    QJsonObject handleJsonRpc(const QJsonObject &message);

signals:
    void runningChanged();
    void enabledChanged();
    void clientRequestsChanged();
    /// Emitted for each new proposal so the UI can ask the user to review it.
    void proposalAdded(QGCMcpProposal *proposal);

private:
    void _start();
    void _stop();
    QByteArray _handleHttpBody(const QByteArray &body, bool &noContent);

    QJsonArray _toolDefinitions() const;
    QJsonObject _callTool(const QString &name, const QJsonObject &args, bool &isError);

    QJsonObject _toolVehicleStatus();
    QJsonObject _toolSearchParameters(const QJsonObject &args, bool &isError);
    QJsonObject _toolGetParameters(const QJsonObject &args, bool &isError);
    QJsonObject _toolListModified(bool &isError);
    QJsonObject _toolProposeChanges(const QJsonObject &args, bool &isError);
    QJsonObject _toolProposalStatus(const QJsonObject &args, bool &isError);
    QJsonObject _toolRcChannels(bool &isError);

    Vehicle *_vehicleWithParams(bool &isError, QJsonObject &errorResult) const;
    static QJsonObject _factSummary(Fact *fact);
    static QJsonObject _factDetail(Fact *fact);
    static QJsonObject _error(const QString &message);
    void _activeVehicleChanged(Vehicle *vehicle);

    QHttpServer *_httpServer = nullptr;
    QTcpServer *_tcpServer = nullptr;
    bool _enabled = true;
    quint16 _port = kDefaultPort;
    QString _errorString;
    QmlObjectListModel _proposals;
    int _nextProposalId = 1;
    int _clientRequests = 0;
    QPointer<Vehicle> _rcVehicle;
    QVector<int> _lastRcPwm;
};
