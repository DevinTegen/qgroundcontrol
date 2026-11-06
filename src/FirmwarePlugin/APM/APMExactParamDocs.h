#pragma once

#include <QtCore/QObject>
#include <QtCore/QPointer>
#include <QtCore/QVersionNumber>

class Vehicle;

/// Fetches the ArduPilot parameter documentation that exactly matches the connected firmware
/// (e.g. Plane 4.6.3), instead of the nearest bundled major.minor set. ArduPilot publishes one
/// apm.pdef.xml per stable release; it is converted to the ParameterRepository JSON layout that
/// APMParameterMetaData already parses and cached so later connects (and offline use) reuse it.
class APMExactParamDocs : public QObject
{
    Q_OBJECT

public:
    explicit APMExactParamDocs(Vehicle *vehicle, const QString &vehicleDocsName, QObject *parent = nullptr);

    /// Returns the cached exact-match JSON for this vehicle/version, or an empty string if not cached.
    static QString cachedFile(const QString &vehicleDocsName, const QVersionNumber &version);

    /// True when ArduPilot publishes versioned docs for this firmware (official releases only).
    static bool versionHasPublishedDocs(const Vehicle *vehicle);

    /// Human readable docs version from a metadata file path, e.g. "Plane 4.6.3 (exact)".
    static QString describeMetaDataFile(const QString &metaDataFile);

    /// Converts ArduPilot apm.pdef.xml into ParameterRepository-style JSON.
    [[nodiscard]] static bool convertXmlToJson(const QByteArray &xml, QByteArray &json, QString *errorString = nullptr);

    /// Starts the download when the docs are published and not already cached.
    void fetchIfNeeded();

signals:
    /// Emitted once the exact-match file has been downloaded, converted and cached.
    void docsReady(const QString &metaDataFile);

private:
    void _downloadFinished(bool success, const QString &localFile, const QString &errorMsg);
    QString _url() const;

    QPointer<Vehicle> _vehicle;
    QString _vehicleDocsName;
    QVersionNumber _version;
    bool _started = false;
};
