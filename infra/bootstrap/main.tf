terraform {
  required_version = ">= 1.14, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 7.0" }
  }
  backend "gcs" {}
}
provider "google" { project = var.project_id }
provider "google" {
  alias                 = "budget"
  project               = var.project_id
  billing_project       = var.project_id
  user_project_override = true
}
variable "project_id" { type = string }
variable "billing_account" { type = string }
variable "github_repository_id" { type = string }
variable "github_owner_id" { type = string }
variable "monthly_budget_yen" {
  type    = number
  default = 1000
}
resource "google_project" "soroeru" {
  project_id      = var.project_id
  name            = "Soroeru Cloud"
  billing_account = var.billing_account
  deletion_policy = "PREVENT"
}
locals {
  region = "asia-northeast1"
  apis   = toset(["serviceusage.googleapis.com", "cloudresourcemanager.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "run.googleapis.com", "artifactregistry.googleapis.com", "firestore.googleapis.com", "bigquery.googleapis.com", "aiplatform.googleapis.com", "secretmanager.googleapis.com", "logging.googleapis.com", "billingbudgets.googleapis.com", "cloudbuild.googleapis.com"])
}
resource "google_project_service" "apis" {
  for_each           = local.apis
  project            = google_project.soroeru.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "google_storage_bucket" "state" {
  for_each                    = toset(["bootstrap", "runtime"])
  name                        = "${var.project_id}-${each.key}-tfstate"
  project                     = google_project.soroeru.project_id
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  versioning { enabled = true }
  lifecycle { prevent_destroy = true }
}
resource "google_artifact_registry_repository" "images" {
  project       = google_project.soroeru.project_id
  location      = local.region
  repository_id = "soroeru"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}
resource "google_service_account" "runtime" {
  for_each     = toset(["api", "pii-fallback"])
  project      = google_project.soroeru.project_id
  account_id   = "soroeru-${each.key}"
  display_name = "Soroeru ${each.key} runtime"
  depends_on   = [google_project_service.apis]
}
resource "google_service_account" "deploy" {
  project      = google_project.soroeru.project_id
  account_id   = "github-deploy"
  display_name = "GitHub Actions Cloud deploy"
  depends_on   = [google_project_service.apis]
}
resource "google_project_iam_member" "api_datastore" {
  project = google_project.soroeru.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime["api"].email}"
}
resource "google_project_iam_member" "vertex" {
  for_each = google_service_account.runtime
  project  = google_project.soroeru.project_id
  role     = "roles/aiplatform.user"
  member   = "serviceAccount:${each.value.email}"
}
# CI manages only runtime infrastructure, never project/billing/WIF/IAM foundation.
resource "google_project_iam_member" "deploy" {
  for_each = toset(["roles/run.admin", "roles/logging.configWriter", "roles/datastore.owner", "roles/artifactregistry.writer", "roles/serviceusage.serviceUsageConsumer"])
  project  = google_project.soroeru.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_service_account_iam_member" "act_as" {
  for_each           = google_service_account.runtime
  service_account_id = each.value.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_storage_bucket_iam_member" "state" {
  bucket = google_storage_bucket.state["runtime"].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deploy.email}"
}
resource "google_secret_manager_secret" "ticket" {
  project   = google_project.soroeru.project_id
  secret_id = "tier3-ticket-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
  lifecycle { prevent_destroy = true }
}
resource "google_secret_manager_secret_iam_member" "ticket" {
  for_each  = google_service_account.runtime
  project   = google_project.soroeru.project_id
  secret_id = google_secret_manager_secret.ticket.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.email}"
}
resource "google_iam_workload_identity_pool" "github" {
  project                   = google_project.soroeru.project_id
  workload_identity_pool_id = "github"
  display_name              = "Soroeru GitHub Actions"
  depends_on                = [google_project_service.apis]
}
resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = google_project.soroeru.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping                  = { "google.subject" = "assertion.sub", "attribute.repository_id" = "assertion.repository_id" }
  attribute_condition                = "assertion.repository_id == '${var.github_repository_id}' && assertion.repository_owner_id == '${var.github_owner_id}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'soroeru/Soroeru/.github/workflows/cloud.yml@refs/heads/main'"
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
}
resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}
resource "google_billing_budget" "monthly" {
  provider        = google.budget
  billing_account = var.billing_account
  display_name    = "Soroeru Cloud monthly alert"
  budget_filter { projects = ["projects/${google_project.soroeru.number}"] }
  amount {
    specified_amount {
      currency_code = "JPY"
      units         = tostring(var.monthly_budget_yen)
    }
  }
  threshold_rules { threshold_percent = 0.5 }
  threshold_rules { threshold_percent = 0.9 }
  threshold_rules { threshold_percent = 1.0 }
  depends_on = [google_project_service.apis]
}
output "project_id" { value = google_project.soroeru.project_id }
output "state_bucket" { value = google_storage_bucket.state["runtime"].name }
output "workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "deploy_service_account" { value = google_service_account.deploy.email }

resource "google_storage_bucket" "build_source" {
  name                        = "${var.project_id}-build-source"
  project                     = google_project.soroeru.project_id
  location                    = local.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
}
resource "google_service_account" "build" {
  project    = google_project.soroeru.project_id
  account_id = "cloud-build"
  depends_on = [google_project_service.apis]
}
resource "google_project_iam_member" "build" {
  for_each = toset(["roles/artifactregistry.writer", "roles/logging.logWriter"])
  project  = google_project.soroeru.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.build.email}"
}
resource "google_storage_bucket_iam_member" "build_source" {
  bucket = google_storage_bucket.build_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.build.email}"
}

resource "google_project_iam_custom_role" "deploy_check" {
  project     = google_project.soroeru.project_id
  role_id     = "soroeruDeploymentCheck"
  title       = "Soroeru deployment IAM verification"
  permissions = ["resourcemanager.projects.getIamPolicy", "aiplatform.cacheConfigs.get", "aiplatform.cacheConfigs.update"]
}
resource "google_project_iam_member" "deploy_check" {
  project = google_project.soroeru.project_id
  role    = google_project_iam_custom_role.deploy_check.name
  member  = "serviceAccount:${google_service_account.deploy.email}"
}
