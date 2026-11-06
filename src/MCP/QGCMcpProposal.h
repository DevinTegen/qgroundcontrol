#pragma once

#include <QtCore/QDateTime>
#include <QtCore/QJsonObject>
#include <QtCore/QObject>
#include <QtCore/QPointer>
#include <QtCore/QVariantList>
#include <QtQmlIntegration/QtQmlIntegration>

class Vehicle;

/// A batch of parameter changes proposed by an AI assistant over MCP. Nothing is written to the vehicle until the
/// user approves it in the QGC UI; the assistant can only poll the outcome.
class QGCMcpProposal : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by QGCMcpServer")

    Q_PROPERTY(int          proposalId  READ proposalId CONSTANT)
    Q_PROPERTY(QString      summary     READ summary    CONSTANT)
    Q_PROPERTY(QString      status      READ status     NOTIFY statusChanged)
    Q_PROPERTY(QString      statusText  READ statusText NOTIFY statusChanged)
    Q_PROPERTY(QVariantList changes     READ changes    NOTIFY changesChanged)
    Q_PROPERTY(bool         pending     READ pending    NOTIFY statusChanged)

public:
    struct Change {
        QString name;
        QString currentValue;   ///< Cooked value string at proposal time
        QString proposedValue;  ///< Cooked value string to write
        QString proposedLabel;  ///< Enum label for proposedValue, if any
        QString units;
        QString description;
        QString reason;
        QString error;          ///< Validation error; changes with errors are never applied
        bool rebootRequired = false;
        bool selected = true;
        QString result;         ///< Outcome after apply: "sent", "skipped", "failed: ..."
    };

    QGCMcpProposal(int proposalId, Vehicle *vehicle, const QString &summary, const QList<Change> &changes, QObject *parent = nullptr);

    int proposalId() const { return _proposalId; }
    QString summary() const { return _summary; }
    QString status() const { return _status; }
    QString statusText() const;
    QVariantList changes() const;
    bool pending() const { return _status == QStringLiteral("pending"); }
    int validChangeCount() const;

    Q_INVOKABLE void setChangeSelected(int index, bool selected);

    /// Writes the selected, valid changes to the vehicle. Refused while armed or if the vehicle changed.
    Q_INVOKABLE void apply();
    Q_INVOKABLE void reject();

    QJsonObject toJson() const;

signals:
    void statusChanged();
    void changesChanged();

private:
    void _setStatus(const QString &status, const QString &detail = QString());

    const int _proposalId;
    QPointer<Vehicle> _vehicle;
    const QString _summary;
    QList<Change> _changes;
    QString _status = QStringLiteral("pending");
    QString _statusDetail;
    QDateTime _created;
    QDateTime _resolved;
};
