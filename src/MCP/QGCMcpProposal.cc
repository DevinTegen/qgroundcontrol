#include "QGCMcpProposal.h"

#include <QtCore/QJsonArray>

#include "Fact.h"
#include "ParameterManager.h"
#include "QGCLoggingCategory.h"
#include "Vehicle.h"

QGC_LOGGING_CATEGORY(QGCMcpProposalLog, "MCP.QGCMcpProposal")

QGCMcpProposal::QGCMcpProposal(int proposalId, Vehicle *vehicle, const QString &summary, const QList<Change> &changes, QObject *parent)
    : QObject(parent)
    , _proposalId(proposalId)
    , _vehicle(vehicle)
    , _summary(summary)
    , _changes(changes)
    , _created(QDateTime::currentDateTime())
{
    for (Change &change : _changes) {
        change.selected = change.error.isEmpty();
    }
}

QString QGCMcpProposal::statusText() const
{
    if (_status == u"pending") {
        return tr("Waiting for your approval");
    } else if (_status == u"applied") {
        return tr("Applied");
    } else if (_status == u"rejected") {
        return tr("Rejected");
    } else if (_status == u"blocked") {
        return tr("Not applied: %1").arg(_statusDetail);
    }
    return _status;
}

QVariantList QGCMcpProposal::changes() const
{
    QVariantList list;
    for (const Change &change : _changes) {
        list.append(QVariantMap{
            {QStringLiteral("name"), change.name},
            {QStringLiteral("currentValue"), change.currentValue},
            {QStringLiteral("proposedValue"), change.proposedValue},
            {QStringLiteral("proposedLabel"), change.proposedLabel},
            {QStringLiteral("units"), change.units},
            {QStringLiteral("description"), change.description},
            {QStringLiteral("reason"), change.reason},
            {QStringLiteral("error"), change.error},
            {QStringLiteral("rebootRequired"), change.rebootRequired},
            {QStringLiteral("selected"), change.selected},
            {QStringLiteral("result"), change.result},
        });
    }
    return list;
}

int QGCMcpProposal::validChangeCount() const
{
    int count = 0;
    for (const Change &change : _changes) {
        if (change.error.isEmpty()) {
            count++;
        }
    }
    return count;
}

void QGCMcpProposal::setChangeSelected(int index, bool selected)
{
    if (!pending() || index < 0 || index >= _changes.size() || !_changes[index].error.isEmpty()) {
        return;
    }
    if (_changes[index].selected != selected) {
        _changes[index].selected = selected;
        emit changesChanged();
    }
}

void QGCMcpProposal::_setStatus(const QString &status, const QString &detail)
{
    _status = status;
    _statusDetail = detail;
    if (status != u"pending") {
        _resolved = QDateTime::currentDateTime();
    }
    emit statusChanged();
}

void QGCMcpProposal::apply()
{
    if (!pending()) {
        return;
    }
    if (!_vehicle) {
        _setStatus(QStringLiteral("blocked"), tr("the vehicle disconnected"));
        return;
    }
    if (_vehicle->armed()) {
        // Stays pending so it can be applied after disarming.
        qCWarning(QGCMcpProposalLog) << "Refusing to apply parameter proposal while armed";
        _statusDetail = tr("vehicle is armed");
        emit statusChanged();
        return;
    }

    ParameterManager *paramMgr = _vehicle->parameterManager();
    for (Change &change : _changes) {
        if (!change.error.isEmpty() || !change.selected) {
            change.result = QStringLiteral("skipped");
            continue;
        }
        if (!paramMgr->parameterExists(ParameterManager::defaultComponentId, change.name)) {
            change.result = QStringLiteral("failed: parameter no longer exists");
            continue;
        }
        Fact *fact = paramMgr->getParameter(ParameterManager::defaultComponentId, change.name);
        const QString error = fact->validate(change.proposedValue, false);
        if (!error.isEmpty()) {
            change.result = QStringLiteral("failed: %1").arg(error);
            continue;
        }
        qCDebug(QGCMcpProposalLog) << "Applying" << change.name << change.currentValue << "->" << change.proposedValue;
        fact->setCookedValue(change.proposedValue);
        change.result = QStringLiteral("sent");
    }

    emit changesChanged();
    _setStatus(QStringLiteral("applied"));
}

void QGCMcpProposal::reject()
{
    if (!pending()) {
        return;
    }
    for (Change &change : _changes) {
        change.result = QStringLiteral("skipped");
    }
    emit changesChanged();
    _setStatus(QStringLiteral("rejected"));
}

QJsonObject QGCMcpProposal::toJson() const
{
    QJsonArray changes;
    for (const Change &change : _changes) {
        QJsonObject obj{
            {QStringLiteral("name"), change.name},
            {QStringLiteral("current_value"), change.currentValue},
            {QStringLiteral("proposed_value"), change.proposedLabel.isEmpty() ? change.proposedValue
                                                                              : QStringLiteral("%1 (%2)").arg(change.proposedValue, change.proposedLabel)},
            {QStringLiteral("units"), change.units},
            {QStringLiteral("selected_by_user"), change.selected},
        };
        if (!change.error.isEmpty()) {
            obj.insert(QStringLiteral("error"), change.error);
        }
        if (change.rebootRequired) {
            obj.insert(QStringLiteral("reboot_required"), true);
        }
        if (!change.result.isEmpty()) {
            obj.insert(QStringLiteral("result"), change.result);
        }
        changes.append(obj);
    }

    QJsonObject json{
        {QStringLiteral("proposal_id"), _proposalId},
        {QStringLiteral("status"), _status},
        {QStringLiteral("summary"), _summary},
        {QStringLiteral("changes"), changes},
    };
    if (!_statusDetail.isEmpty()) {
        json.insert(QStringLiteral("status_detail"), _statusDetail);
    }
    if (pending()) {
        json.insert(QStringLiteral("note"),
                    QStringLiteral("Waiting for the user to review this in QGroundControl and click Apply or Reject. "
                                   "Changes are never written without that approval."));
    }
    return json;
}
