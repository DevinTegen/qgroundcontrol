#pragma once

#include <QtCore/QElapsedTimer>
#include <QtCore/QObject>
#include <QtCore/QTimer>
#include <QtQmlIntegration/QtQmlIntegration>

#include "FactPanelController.h"
#include "QmlObjectListModel.h"

class Fact;

/// One RC input channel: live PWM plus everything ArduPilot maps onto it.
class APMRCChannelInfo : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by APMRCMappingController")
    Q_MOC_INCLUDE("Fact.h")

    Q_PROPERTY(int      channel         MEMBER channel          CONSTANT)
    Q_PROPERTY(int      pwm             READ pwm                NOTIFY pwmChanged)
    Q_PROPERTY(bool     moving          READ moving             NOTIFY movingChanged)
    Q_PROPERTY(QString  primaryFunction READ primaryFunction    NOTIFY mappingChanged)
    Q_PROPERTY(QString  conflict        READ conflict           NOTIFY mappingChanged)
    Q_PROPERTY(Fact*    optionFact      MEMBER optionFact       CONSTANT)
    Q_PROPERTY(Fact*    reversedFact    MEMBER reversedFact     CONSTANT)
    Q_PROPERTY(Fact*    minFact         MEMBER minFact          CONSTANT)
    Q_PROPERTY(Fact*    maxFact         MEMBER maxFact          CONSTANT)
    Q_PROPERTY(Fact*    trimFact        MEMBER trimFact         CONSTANT)

public:
    explicit APMRCChannelInfo(int channel, QObject *parent = nullptr);

    int pwm() const { return _pwm; }
    bool moving() const { return _moving; }
    QString primaryFunction() const { return _primaryFunction; }
    QString conflict() const { return _conflict; }

    void setPwm(int pwm);
    void setMoving(bool moving);
    void setMapping(const QString &primaryFunction, const QString &conflict);

    const int channel;
    Fact *optionFact = nullptr;
    Fact *reversedFact = nullptr;
    Fact *minFact = nullptr;
    Fact *maxFact = nullptr;
    Fact *trimFact = nullptr;

    int baselinePwm = -1;
    QElapsedTimer lastMoved;

signals:
    void pwmChanged();
    void movingChanged();
    void mappingChanged();

private:
    int _pwm = 0;
    bool _moving = false;
    QString _primaryFunction;
    QString _conflict;
};

/// Live view of every RC input with its ArduPilot mapping (RCMAP_*, flight mode channel, RCn_OPTION).
/// Moving a stick or switch highlights its channel so it can be identified and assigned.
class APMRCMappingController : public FactPanelController
{
    Q_OBJECT
    QML_ELEMENT

    Q_PROPERTY(QmlObjectListModel*  channels            READ channels           CONSTANT)
    Q_PROPERTY(int                  receivedChannels    READ receivedChannels   NOTIFY receivedChannelsChanged)
    Q_PROPERTY(int                  lastMovedChannel    READ lastMovedChannel   NOTIFY lastMovedChannelChanged)
    Q_PROPERTY(QString              flightModeParam     READ flightModeParam    CONSTANT)
    Q_PROPERTY(QStringList          primaryAxes         READ primaryAxes        CONSTANT)

public:
    explicit APMRCMappingController(QObject *parent = nullptr);
    ~APMRCMappingController() override;

    QmlObjectListModel *channels() { return &_channels; }
    int receivedChannels() const { return _receivedChannels; }
    int lastMovedChannel() const { return _lastMovedChannel; }
    QString flightModeParam() const { return _flightModeParam; }
    QStringList primaryAxes() const;

    /// Assigns @a channel (1-based) to a primary axis ("Roll", "Pitch", "Throttle", "Yaw") or the flight mode switch.
    Q_INVOKABLE void assignFunction(const QString &function, int channel);

    /// Primary function currently held by @a channel, or empty.
    Q_INVOKABLE QString functionForChannel(int channel) const;

signals:
    void receivedChannelsChanged();
    void lastMovedChannelChanged();

private:
    void _rcChannelsChanged(QVector<int> pwmValues);
    void _updateMappings();
    void _expireMoving();
    Fact *_fact(const QString &name) const;

    static constexpr int kMaxChannels = 16;
    static constexpr int kMoveThresholdPwm = 40;
    static constexpr int kMovingHoldMs = 1500;

    QmlObjectListModel _channels;
    QTimer _movingTimer;
    int _receivedChannels = 0;
    int _lastMovedChannel = 0;
    QString _flightModeParam;
};
