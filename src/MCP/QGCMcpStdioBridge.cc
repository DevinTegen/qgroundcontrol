#include "QGCMcpStdioBridge.h"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>

#include <QtCore/QByteArray>
#include <QtCore/QCoreApplication>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QMetaObject>
#include <QtCore/QQueue>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtNetwork/QNetworkAccessManager>
#include <QtNetwork/QNetworkReply>
#include <QtNetwork/QNetworkRequest>

#include "QGCMcpServer.h"

namespace {

constexpr int kRequestTimeoutMs = 30000;

class McpBridgeRelay : public QObject
{
public:
    explicit McpBridgeRelay(const QUrl &endpoint, QObject *parent = nullptr)
        : QObject(parent)
        , _endpoint(endpoint)
    {
    }

    void enqueue(const QByteArray &line)
    {
        _queue.enqueue(line);
        _next();
    }

    void inputClosed()
    {
        _inputClosed = true;
        if (!_busy && _queue.isEmpty()) {
            QCoreApplication::quit();
        }
    }

private:
    void _next()
    {
        if (_busy) {
            return;
        }
        if (_queue.isEmpty()) {
            if (_inputClosed) {
                QCoreApplication::quit();
            }
            return;
        }

        _busy = true;
        const QByteArray message = _queue.dequeue();
        const QJsonObject json = QJsonDocument::fromJson(message).object();
        const QJsonValue id = json.value(QStringLiteral("id"));
        const bool isRequest = json.contains(QStringLiteral("id"));

        QNetworkRequest request(_endpoint);
        request.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
        request.setRawHeader("Accept", "application/json, text/event-stream");
        request.setTransferTimeout(kRequestTimeoutMs);

        QNetworkReply *reply = _network.post(request, message);
        (void) connect(reply, &QNetworkReply::finished, this, [this, reply, id, isRequest]() {
            reply->deleteLater();
            const QByteArray body = reply->readAll();
            if (reply->error() != QNetworkReply::NoError && body.isEmpty()) {
                if (isRequest) {
                    const QJsonObject error{
                        {QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
                        {QStringLiteral("id"), id},
                        {QStringLiteral("error"), QJsonObject{
                            {QStringLiteral("code"), -32000},
                            {QStringLiteral("message"), QStringLiteral("QGroundControl is not running, or its Claude "
                                                                       "connection is turned off (%1).").arg(reply->errorString())},
                        }},
                    };
                    _write(QJsonDocument(error).toJson(QJsonDocument::Compact));
                }
            } else if (!body.trimmed().isEmpty()) {
                _write(body.trimmed());
            }
            _busy = false;
            _next();
        });
    }

    static void _write(const QByteArray &line)
    {
        std::fwrite(line.constData(), 1, static_cast<size_t>(line.size()), stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
    }

    QNetworkAccessManager _network;
    const QUrl _endpoint;
    QQueue<QByteArray> _queue;
    bool _busy = false;
    bool _inputClosed = false;
};

} // namespace

bool QGCMcpStdioBridge::requested(int argc, char *argv[])
{
    for (int i = 1; i < argc; i++) {
        if (std::strcmp(argv[i], "--mcp-bridge") == 0) {
            return true;
        }
    }
    return false;
}

int QGCMcpStdioBridge::run(int argc, char *argv[])
{
    QCoreApplication app(argc, argv);

    quint16 port = QGCMcpServer::kDefaultPort;
    for (int i = 1; i + 1 < argc; i++) {
        if (std::strcmp(argv[i], "--mcp-port") == 0) {
            port = static_cast<quint16>(QByteArray(argv[i + 1]).toUShort());
        }
    }

    McpBridgeRelay relay(QUrl(QStringLiteral("http://127.0.0.1:%1/mcp").arg(port)));

    // stdin is read on a plain thread; each line is handed to the Qt thread in order.
    std::thread reader([&relay]() {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) {
                continue;
            }
            const QByteArray bytes = QByteArray::fromStdString(line);
            QMetaObject::invokeMethod(&relay, [&relay, bytes]() { relay.enqueue(bytes); }, Qt::QueuedConnection);
        }
        QMetaObject::invokeMethod(&relay, [&relay]() { relay.inputClosed(); }, Qt::QueuedConnection);
    });
    reader.detach();

    return app.exec();
}
