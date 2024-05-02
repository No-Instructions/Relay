import sys
import signal
from inotify.adapters import InotifyTree

def main(directory):
    inotify = InotifyTree(directory)
    
    def signal_handler(sig, frame):
        print('Stopping...')
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    print(f"Listening for changes in: {directory}")

    for event in inotify.event_gen(yield_nones=False):
        (_, type_names, path, filename) = event
        if 'IN_MODIFY' in type_names:
            print(f"Modified file: {path}/{filename}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python watch.py <directory>")
        sys.exit(1)
    
    main(sys.argv[1])

