#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static const NSInteger VNSessionLimitSeconds = 60 * 60;
static const NSInteger VNSpeechSegmentSeconds = 50;

@interface VoiceNoteAppDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) NSTextView *transcriptView;
@property (nonatomic, strong) NSTextField *statusLabel;
@property (nonatomic, strong) NSTextField *timerLabel;
@property (nonatomic, strong) NSPopUpButton *languagePicker;
@property (nonatomic, strong) NSButton *startButton;
@property (nonatomic, strong) NSButton *pauseButton;
@property (nonatomic, strong) NSButton *finishButton;
@property (nonatomic, strong) NSButton *exportButton;
@property (nonatomic, strong) AVAudioEngine *audioEngine;
@property (nonatomic, strong) SFSpeechRecognizer *recognizer;
@property (nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *speechRequest;
@property (nonatomic, strong) SFSpeechRecognitionTask *speechTask;
@property (nonatomic, strong) NSTimer *sessionTimer;
@property (nonatomic, strong) NSLock *requestLock;
@property (nonatomic, strong) NSMutableArray<NSString *> *segmentTexts;
@property (nonatomic, copy) NSString *phase;
@property (nonatomic) NSInteger elapsedSeconds;
@property (nonatomic) NSInteger activeSegmentIdentifier;
@property (nonatomic) BOOL tapInstalled;
@end

@implementation VoiceNoteAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.phase = @"idle";
    self.requestLock = [NSLock new];
    self.segmentTexts = [NSMutableArray array];
    [self buildWindow];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (NSButton *)button:(NSString *)title action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bezelStyle = NSBezelStyleRounded;
    return button;
}

- (NSTextField *)label:(NSString *)text size:(CGFloat)size weight:(NSFontWeight)weight {
    NSTextField *label = [NSTextField labelWithString:text];
    label.font = [NSFont systemFontOfSize:size weight:weight];
    return label;
}

- (void)buildWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 820, 680)
                                              styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"VoiceNote";
    self.window.minSize = NSMakeSize(680, 560);
    [self.window center];

    NSView *root = [NSView new];
    self.window.contentView = root;

    NSTextField *title = [self label:@"VoiceNote" size:28 weight:NSFontWeightSemibold];
    NSTextField *subtitle = [self label:@"On-device dictation sessions up to 60 minutes" size:13 weight:NSFontWeightRegular];
    subtitle.textColor = NSColor.secondaryLabelColor;
    NSStackView *heading = [NSStackView stackViewWithViews:@[title, subtitle]];
    heading.orientation = NSUserInterfaceLayoutOrientationVertical;
    heading.alignment = NSLayoutAttributeLeading;
    heading.spacing = 4;

    self.timerLabel = [self label:@"00:00 / 60:00" size:16 weight:NSFontWeightMedium];
    self.timerLabel.font = [NSFont monospacedDigitSystemFontOfSize:16 weight:NSFontWeightMedium];
    NSStackView *top = [NSStackView stackViewWithViews:@[heading, self.timerLabel]];
    top.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    top.alignment = NSLayoutAttributeCenterY;
    top.distribution = NSStackViewDistributionFill;
    top.spacing = 16;

    self.startButton = [self button:@"Start recording" action:@selector(startOrResume:)];
    self.startButton.keyEquivalent = @"\r";
    self.pauseButton = [self button:@"Pause" action:@selector(pauseRecording:)];
    self.finishButton = [self button:@"Finish" action:@selector(finishRecording:)];
    self.languagePicker = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
    [self.languagePicker addItemsWithTitles:@[@"English (US)", @"English (UK)", @"Español", @"Français", @"Deutsch", @"हिन्दी"]];
    self.languagePicker.target = self;
    self.languagePicker.action = @selector(languageChanged:);
    self.languagePicker.accessibilityLabel = @"Recognition language";
    NSStackView *controls = [NSStackView stackViewWithViews:@[self.startButton, self.pauseButton, self.finishButton, self.languagePicker]];
    controls.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    controls.alignment = NSLayoutAttributeCenterY;
    controls.spacing = 10;
    controls.distribution = NSStackViewDistributionFill;

    self.statusLabel = [self label:@"Ready. Start when you are ready to dictate." size:13 weight:NSFontWeightRegular];
    self.statusLabel.textColor = NSColor.secondaryLabelColor;
    self.statusLabel.maximumNumberOfLines = 2;
    self.statusLabel.lineBreakMode = NSLineBreakByWordWrapping;
    self.statusLabel.accessibilityLabel = @"Recording status";

    self.transcriptView = [NSTextView new];
    self.transcriptView.font = [NSFont systemFontOfSize:15];
    self.transcriptView.minSize = NSMakeSize(0, 0);
    self.transcriptView.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
    self.transcriptView.verticallyResizable = YES;
    self.transcriptView.horizontallyResizable = NO;
    self.transcriptView.autoresizingMask = NSViewWidthSizable;
    self.transcriptView.textContainer.containerSize = NSMakeSize(0, CGFLOAT_MAX);
    self.transcriptView.textContainer.widthTracksTextView = YES;
    self.transcriptView.accessibilityLabel = @"Editable transcript";

    NSScrollView *scroll = [NSScrollView new];
    scroll.hasVerticalScroller = YES;
    scroll.borderType = NSBezelBorder;
    scroll.documentView = self.transcriptView;
    scroll.translatesAutoresizingMaskIntoConstraints = NO;

    NSButton *clearButton = [self button:@"Clear" action:@selector(clearTranscript:)];
    self.exportButton = [self button:@"Export .txt" action:@selector(exportTranscript:)];
    NSStackView *footerButtons = [NSStackView stackViewWithViews:@[clearButton, self.exportButton]];
    footerButtons.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    footerButtons.spacing = 10;

    NSTextField *privacy = [self label:@"Audio is requested in on-device-only mode. Nothing is sent by this app to a server. Export regularly; transcripts are not saved automatically." size:11 weight:NSFontWeightRegular];
    privacy.textColor = NSColor.secondaryLabelColor;
    privacy.maximumNumberOfLines = 2;
    privacy.lineBreakMode = NSLineBreakByWordWrapping;

    NSStackView *footer = [NSStackView stackViewWithViews:@[privacy, footerButtons]];
    footer.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    footer.alignment = NSLayoutAttributeCenterY;
    footer.distribution = NSStackViewDistributionFill;
    footer.spacing = 12;

    NSStackView *mainStack = [NSStackView stackViewWithViews:@[top, controls, self.statusLabel, scroll, footer]];
    mainStack.orientation = NSUserInterfaceLayoutOrientationVertical;
    mainStack.alignment = NSLayoutAttributeWidth;
    mainStack.distribution = NSStackViewDistributionFill;
    mainStack.spacing = 16;
    mainStack.translatesAutoresizingMaskIntoConstraints = NO;
    [root addSubview:mainStack];
    [NSLayoutConstraint activateConstraints:@[
        [mainStack.leadingAnchor constraintEqualToAnchor:root.leadingAnchor constant:24],
        [mainStack.trailingAnchor constraintEqualToAnchor:root.trailingAnchor constant:-24],
        [mainStack.topAnchor constraintEqualToAnchor:root.topAnchor constant:24],
        [mainStack.bottomAnchor constraintEqualToAnchor:root.bottomAnchor constant:-24],
        [scroll.heightAnchor constraintGreaterThanOrEqualToConstant:340],
        [self.timerLabel.widthAnchor constraintGreaterThanOrEqualToConstant:130]
    ]];
    [self updateControls];
}

- (NSString *)localeIdentifier {
    NSArray<NSString *> *identifiers = @[@"en-US", @"en-GB", @"es-ES", @"fr-FR", @"de-DE", @"hi-IN"];
    NSInteger index = self.languagePicker.indexOfSelectedItem;
    if (index < 0 || index >= (NSInteger)identifiers.count) return @"en-US";
    return identifiers[(NSUInteger)index];
}

- (void)languageChanged:(id)sender {
    if ([self.phase isEqualToString:@"recording"]) return;
    self.recognizer = nil;
}

- (void)startOrResume:(id)sender {
    if ([self.phase isEqualToString:@"recording"] || [self.phase isEqualToString:@"requesting"]) return;
    if (self.elapsedSeconds >= VNSessionLimitSeconds) {
        self.statusLabel.stringValue = @"The 60-minute session limit has been reached. Export your transcript.";
        return;
    }
    if ([self.phase isEqualToString:@"paused"]) {
        [self beginCapture];
        return;
    }

    self.phase = @"requesting";
    self.statusLabel.stringValue = @"Requesting speech and microphone access…";
    [self updateControls];
    __weak typeof(self) weakSelf = self;
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) self = weakSelf;
            if (!self) return;
            if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                self.phase = @"failed";
                self.statusLabel.stringValue = @"Speech recognition permission was not granted. Enable it in System Settings and try again.";
                [self updateControls];
                return;
            }
            [AVAudioApplication requestRecordPermissionWithCompletionHandler:^(BOOL granted) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    typeof(self) self = weakSelf;
                    if (!self) return;
                    if (!granted) {
                        self.phase = @"failed";
                        self.statusLabel.stringValue = @"Microphone permission was not granted. Enable it in System Settings and try again.";
                        [self updateControls];
                        return;
                    }
                    [self beginCapture];
                });
            }];
        });
    }];
}

- (void)beginCapture {
    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:[self localeIdentifier]]];
    if (!recognizer) {
        self.phase = @"failed";
        self.statusLabel.stringValue = @"Apple Speech does not support this language on this Mac.";
        [self updateControls];
        return;
    }
    self.recognizer = recognizer;

    @try {
        self.audioEngine = [AVAudioEngine new];
        AVAudioInputNode *input = self.audioEngine.inputNode;
        AVAudioFormat *format = [input outputFormatForBus:0];
        [self beginRecognitionSegment];
        __weak typeof(self) weakSelf = self;
        [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
            typeof(self) self = weakSelf;
            if (!self) return;
            [self.requestLock lock];
            SFSpeechAudioBufferRecognitionRequest *request = self.speechRequest;
            if (request) [request appendAudioPCMBuffer:buffer];
            [self.requestLock unlock];
        }];
        self.tapInstalled = YES;
        [self.audioEngine prepare];
        NSError *error = nil;
        if (![self.audioEngine startAndReturnError:&error]) {
            [self stopAudioPipeline];
            self.phase = @"failed";
            self.statusLabel.stringValue = [NSString stringWithFormat:@"Could not start audio capture: %@", error.localizedDescription ?: @"audio engine failed"];
            [self updateControls];
            return;
        }
        self.phase = @"recording";
        self.statusLabel.stringValue = @"Recording on device. Recognition rotates segments to support long sessions; export regularly.";
        self.sessionTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
        self.transcriptView.editable = NO;
        [self updateControls];
    } @catch (NSException *exception) {
        [self stopAudioPipeline];
        self.phase = @"failed";
        self.statusLabel.stringValue = [NSString stringWithFormat:@"Could not start audio capture: %@", exception.reason ?: @"unknown error"];
        [self updateControls];
    }
}

- (void)beginRecognitionSegment {
    SFSpeechAudioBufferRecognitionRequest *request = [SFSpeechAudioBufferRecognitionRequest new];
    request.shouldReportPartialResults = YES;
    request.taskHint = SFSpeechRecognitionTaskHintDictation;
    request.requiresOnDeviceRecognition = YES;
    if (@available(macOS 13.0, *)) request.addsPunctuation = YES;

    NSInteger segmentID = ++self.activeSegmentIdentifier;
    [self.segmentTexts addObject:@""];
    __weak typeof(self) weakSelf = self;
    SFSpeechRecognitionTask *task = [self.recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        typeof(self) self = weakSelf;
        if (!self) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) self = weakSelf;
            if (!self) return;
            NSUInteger index = (NSUInteger)(segmentID - 1);
            if (result && index < self.segmentTexts.count) {
                self.segmentTexts[index] = result.bestTranscription.formattedString ?: @"";
                [self renderTranscript];
            }
            if (error && segmentID == self.activeSegmentIdentifier && [self.phase isEqualToString:@"recording"]) {
                [self stopAudioPipeline];
                self.phase = @"failed";
                self.statusLabel.stringValue = [NSString stringWithFormat:@"On-device recognition stopped: %@. Your completed text is still available.", error.localizedDescription];
                self.transcriptView.editable = YES;
                [self updateControls];
            }
        });
    }];

    [self.requestLock lock];
    SFSpeechAudioBufferRecognitionRequest *previousRequest = self.speechRequest;
    SFSpeechRecognitionTask *previousTask = self.speechTask;
    self.speechRequest = request;
    self.speechTask = task;
    [self.requestLock unlock];
    [previousRequest endAudio];
    [previousTask finish];
}

- (void)renderTranscript {
    NSString *text = [[self.segmentTexts filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSString *value, NSDictionary *bindings) {
        return value.length > 0;
    }]] componentsJoinedByString:@" "];
    self.transcriptView.string = text ?: @"";
    [self.transcriptView scrollRangeToVisible:NSMakeRange(self.transcriptView.string.length, 0)];
    self.exportButton.enabled = self.transcriptView.string.length > 0;
}

- (void)tick:(NSTimer *)timer {
    if (![self.phase isEqualToString:@"recording"]) return;
    self.elapsedSeconds += 1;
    self.timerLabel.stringValue = [NSString stringWithFormat:@"%02ld:%02ld / 60:00", (long)(self.elapsedSeconds / 60), (long)(self.elapsedSeconds % 60)];
    if (self.elapsedSeconds >= VNSessionLimitSeconds) {
        [self finishRecording:nil];
    } else if (self.elapsedSeconds % VNSpeechSegmentSeconds == 0) {
        [self beginRecognitionSegment];
    }
}

- (void)pauseRecording:(id)sender {
    if (![self.phase isEqualToString:@"recording"]) return;
    [self stopAudioPipeline];
    self.phase = @"paused";
    self.statusLabel.stringValue = @"Paused. Resume to continue; export before closing.";
    self.transcriptView.editable = YES;
    [self updateControls];
}

- (void)finishRecording:(id)sender {
    if (![self.phase isEqualToString:@"recording"] && ![self.phase isEqualToString:@"paused"] && ![self.phase isEqualToString:@"failed"]) return;
    [self stopAudioPipeline];
    self.phase = @"finished";
    self.statusLabel.stringValue = @"Session finished. Export your transcript before closing.";
    self.transcriptView.editable = YES;
    [self updateControls];
}

- (void)stopAudioPipeline {
    [self.sessionTimer invalidate];
    self.sessionTimer = nil;
    if (self.tapInstalled) {
        [self.audioEngine.inputNode removeTapOnBus:0];
        self.tapInstalled = NO;
    }
    [self.audioEngine stop];
    [self.requestLock lock];
    SFSpeechAudioBufferRecognitionRequest *request = self.speechRequest;
    SFSpeechRecognitionTask *task = self.speechTask;
    self.speechRequest = nil;
    self.speechTask = nil;
    [self.requestLock unlock];
    [request endAudio];
    [task finish];
    self.audioEngine = nil;
}

- (void)clearTranscript:(id)sender {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"Clear transcript?";
    alert.informativeText = @"This removes the in-memory transcript. Export it first if you need a copy.";
    [alert addButtonWithTitle:@"Cancel"];
    [alert addButtonWithTitle:@"Clear"];
    if ([alert runModal] != NSAlertSecondButtonReturn) return;
    [self.segmentTexts removeAllObjects];
    self.transcriptView.string = @"";
    self.exportButton.enabled = NO;
}

- (void)exportTranscript:(id)sender {
    NSString *text = self.transcriptView.string ?: @"";
    if (text.length == 0) {
        self.statusLabel.stringValue = @"There is no transcript to export yet.";
        return;
    }
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.allowedContentTypes = @[[UTType typeWithFilenameExtension:@"txt"] ?: UTTypePlainText];
    panel.nameFieldStringValue = @"VoiceNote-Transcript.txt";
    panel.canCreateDirectories = YES;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response != NSModalResponseOK || !panel.URL) return;
        NSError *error = nil;
        if ([text writeToURL:panel.URL atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
            self.statusLabel.stringValue = [NSString stringWithFormat:@"Transcript exported to %@.", panel.URL.lastPathComponent];
        } else {
            self.statusLabel.stringValue = [NSString stringWithFormat:@"Export failed: %@", error.localizedDescription];
        }
    }];
}

- (void)updateControls {
    BOOL recording = [self.phase isEqualToString:@"recording"];
    BOOL paused = [self.phase isEqualToString:@"paused"];
    BOOL requesting = [self.phase isEqualToString:@"requesting"];
    BOOL finished = [self.phase isEqualToString:@"finished"];
    self.startButton.title = paused ? @"Resume" : @"Start recording";
    self.startButton.enabled = !recording && !requesting && !finished && self.elapsedSeconds < VNSessionLimitSeconds;
    self.pauseButton.enabled = recording;
    self.finishButton.enabled = recording || paused || [self.phase isEqualToString:@"failed"];
    self.languagePicker.enabled = !recording && !requesting;
    self.exportButton.enabled = self.transcriptView.string.length > 0;
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        VoiceNoteAppDelegate *delegate = [VoiceNoteAppDelegate new];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
