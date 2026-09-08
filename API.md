# AGmeet API Documentation

## Authentication
Include your GitHub Personal Access Token in the request headers:
```
Authorization: token YOUR_GITHUB_PAT
```

## Endpoints

### Get Repository Information
```
GET /repos/AGlegendery/AGmeet
```

### List Repository Contents
```
GET /repos/AGlegendery/AGmeet/contents/
```

### Get Specific File
```
GET /repos/AGlegendery/AGmeet/contents/{path}
```

### Create/Update File
```
PUT /repos/AGlegendery/AGmeet/contents/{path}
```

Body:
```json
{
  "message": "commit message",
  "content": "base64 encoded file content",
  "branch": "main"
}
```

### List Issues
```
GET /repos/AGlegendery/AGmeet/issues
```

### List Pull Requests
```
GET /repos/AGlegendery/AGmeet/pulls
```

### Create Issue
```
POST /repos/AGlegendery/AGmeet/issues
```

Body:
```json
{
  "title": "Issue Title",
  "body": "Issue description",
  "labels": ["bug", "feature"]
}
```

## Base URL
```
https://api.github.com
```

## Rate Limits
- Authenticated: 5,000 requests per hour
- Unauthenticated: 60 requests per hour

## Repository URL
https://github.com/AGlegendery/AGmeet
