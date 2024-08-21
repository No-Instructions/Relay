import os
import json
import click
import git
import time
from github import Github

REMOTE = os.environ.get("ORIGIN", "origin")

def set_version(file_path, new_version):

    with open(file_path, 'r') as file:
        data = json.load(file)
    
    data['version'] = new_version

    with open(file_path, 'w') as file:
        json.dump(data, file, indent=2)

    return new_version


def bump_version(file_path, version_type):
    with open(file_path, 'r') as file:
        data = json.load(file)

    current_version = data['version']
    major, minor, patch = map(int, current_version.split('.'))

    if version_type == 'major':
        major += 1
        minor = 0
        patch = 0
    elif version_type == 'minor':
        minor += 1
        patch = 0
    elif version_type == 'patch':
        patch += 1
    elif version_type == 'force':
        pass
    else:
        raise ValueError("Invalid version type. Use 'major', 'minor', 'patch', or 'force'.")

    new_version = f"{major}.{minor}.{patch}"
    data['version'] = new_version

    with open(file_path, 'w') as file:
        json.dump(data, file, indent=2)

    return new_version

def delete_tag(repo, tag_name):
    try:
        repo.git.push('--delete', REMOTE, tag_name)
    except git.exc.GitCommandError:
        pass
    try:
        repo.delete_tag(tag_name)
    except git.exc.GitCommandError:
        pass

@click.command()
@click.argument('version_type')
def main(version_type):
    manifest_file = "manifest.json"
    beta_manifest_file = "manifest-beta.json"
    repo = git.Repo('.')
    g = Github()
    repo_name = "no-instructions/relay"

    new_beta_version = bump_version(beta_manifest_file, version_type)
    new_version = set_version(manifest_file, new_beta_version)

    # Delete tags
    delete_tag(repo, new_version)

    # Create a commit for the version bump
    repo.git.add(manifest_file)
    repo.git.add(beta_manifest_file)
    try:
        repo.git.commit(m=f"version: bump the version to {new_version}")
    except git.exc.GitCommandError:
        pass

    # Push the commit
    force = (version_type == 'force')
    repo.git.push(force=force)

    # Create a new tag
    repo.create_tag(new_version)

    # Push the new tag
    remote = repo.remote(name=REMOTE)
    remote.push(new_version)

    # Wait for GitHub to create the release
    print("Waiting for GitHub to create the release...")
    time.sleep(30)

    # Check if release is created
    repo = g.get_repo(repo_name)
    releases = repo.get_releases()
    release_names = [release.tag_name for release in releases]

    if new_version in release_names:
        print(f"Release {new_version} created successfully.")
    else:
        print(f"Release {new_version} not found.")

if __name__ == "__main__":
    main()
