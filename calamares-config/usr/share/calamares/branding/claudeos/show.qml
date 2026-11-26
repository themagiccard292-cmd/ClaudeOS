// ClaudeOS installation slideshow (Calamares slideshow API 2). Cards are pure QML (see Card.qml).
import QtQuick 2.0;
import calamares.slideshow 1.0;

Presentation {
    id: presentation

    Timer {
        interval: 9000
        running: presentation.activatedInCalamares
        repeat: true
        onTriggered: presentation.goToNextSlide()
    }

    Slide { Card { heading: "Welcome to ClaudeOS"; body: "Ubuntu, with Claude built into the desktop. Installing now." } }
    Slide { Card { heading: "Claude lives in your side panel"; body: "Press Super+C to open or hide it from anywhere." } }
    Slide { Card { heading: "Ask Claude from any file"; body: "Right-click a file or folder in Files and choose Ask Claude." } }
    Slide { Card { heading: "Claude can see your screen and use apps"; body: "Anything risky waits for your confirmation first." } }
    Slide { Card { heading: "Sign in once"; body: "Use your Claude account the first time you log in. No API keys needed." } }

    function onActivate() {
        presentation.currentSlide = 0;
    }

    function onLeave() {
    }
}
