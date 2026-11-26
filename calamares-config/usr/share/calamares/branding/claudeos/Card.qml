// One slideshow card (used by show.qml). Palette: ARCHITECTURE C8 (dark).
import QtQuick 2.0;

Rectangle {
    id: card
    property string heading
    property string body
    readonly property color fg: "#F5F4EF"
    readonly property color muted: "#A5A39B"
    readonly property color accent: "#D97757"

    anchors.fill: parent
    color: "#262624"

    Rectangle {
        id: dot
        width: 14; height: 14; radius: 7
        color: card.accent
        anchors.horizontalCenter: parent.horizontalCenter
        y: parent.height * 0.26
    }
    Text {
        id: title
        anchors.top: dot.bottom
        anchors.topMargin: 24
        anchors.horizontalCenter: parent.horizontalCenter
        width: parent.width * 0.8
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
        text: card.heading
        color: card.fg
        font.family: "Newsreader, Tiempos Text, Georgia, serif"
        font.pixelSize: 34
    }
    Text {
        anchors.top: title.bottom
        anchors.topMargin: 16
        anchors.horizontalCenter: parent.horizontalCenter
        width: parent.width * 0.7
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
        text: card.body
        color: card.muted
        font.family: "Inter, Styrene B, sans-serif"
        font.pixelSize: 17
    }
}
