targetScope = 'resourceGroup'

@description('Azure region for platform resources.')
param location string = resourceGroup().location

@description('Log Analytics workspace name.')
param logAnalyticsWorkspaceName string

@description('Container Apps environment name.')
param containerAppEnvironmentName string

@description('Container App name for APCL.')
param containerAppName string

@description('Azure Container Registry name (globally unique, 5-50 lowercase alphanumeric).')
param containerRegistryName string

@description('Key Vault name (globally unique).')
param keyVaultName string

@description('Storage account name for APCL state/audit volume (globally unique, lowercase, 3-24 chars).')
param stateStorageAccountName string

@description('Azure Files share name mounted into Container App for APCL state.')
param stateFileShareName string = 'apclstate'

@description('Secret name in Key Vault used by APCL entitlement signing.')
param entitlementSecretName string = 'apcl-entitlement-secret'

@secure()
@description('Secret value stored in Key Vault for APCL entitlement signing.')
param entitlementSecretValue string

@description('Container image to run in Azure Container Apps.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Container ingress exposure setting.')
param enableExternalIngress bool = false

@description('Container target port.')
param containerTargetPort int = 3000

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      searchVersion: 1
    }
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    enableRbacAuthorization: true
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    softDeleteRetentionInDays: 90
    enabledForTemplateDeployment: true
    enabledForDeployment: true
    enabledForDiskEncryption: false
    publicNetworkAccess: 'Enabled'
  }
}

resource stateStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stateStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource stateFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: stateStorageAccount
  name: 'default'
}

resource stateFileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: stateFileService
  name: stateFileShareName
  properties: {
    accessTier: 'TransactionOptimized'
    enabledProtocols: 'SMB'
  }
}

resource entitlementSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: entitlementSecretName
  properties: {
    value: entitlementSecretValue
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvironmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppsEnvironment
  name: 'apclstate'
  properties: {
    azureFile: {
      accountName: stateStorageAccount.name
      accountKey: stateStorageAccount.listKeys().keys[0].value
      shareName: stateFileShare.name
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: enableExternalIngress
        targetPort: containerTargetPort
        transport: 'auto'
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'apcl-entitlement-secret'
          keyVaultUrl: entitlementSecret.properties.secretUriWithVersion
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'apcl'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          volumeMounts: [
            {
              volumeName: 'apcl-state'
              mountPath: '/var/lib/apcl'
            }
          ]
          env: [
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'APCL_ENTITLEMENT_SECRET'
              secretRef: 'apcl-entitlement-secret'
            }
            {
              name: 'APCL_ENTITLEMENT_TTL_MINUTES'
              value: '60'
            }
            {
              name: 'APCL_DEPLOYMENT_MODE'
              value: 'webhook'
            }
            {
              name: 'APCL_AUTH_MODE'
              value: 'easyauth'
            }
            {
              name: 'APCL_STATE_BACKEND'
              value: 'sqlite'
            }
            {
              name: 'APCL_SQLITE_DB_PATH'
              value: '/var/lib/apcl/state/apcl.db'
            }
            {
              name: 'APCL_AUDIT_EXPORT_PATH'
              value: '/var/lib/apcl/audit/audit-export.jsonl'
            }
            {
              name: 'APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET'
              value: ''
            }
            {
              name: 'APCL_DEPLOYMENT_STATUS_TOKEN'
              value: ''
            }
            {
              name: 'APCL_DEPLOYMENT_WEBHOOK_TIMEOUT_MS'
              value: '10000'
            }
            {
              name: 'APCL_DEPLOYMENT_WEBHOOK_RETRY_COUNT'
              value: '2'
            }
            {
              name: 'APCL_DEPLOYMENT_WEBHOOK_RETRY_DELAY_MS'
              value: '500'
            }
            {
              name: 'APCL_DEPLOYMENT_POLL_ENABLED'
              value: 'false'
            }
            {
              name: 'APCL_DEPLOYMENT_POLL_URL_TEMPLATE'
              value: ''
            }
            {
              name: 'APCL_DEPLOYMENT_POLL_INTERVAL_MS'
              value: '2000'
            }
            {
              name: 'APCL_DEPLOYMENT_POLL_MAX_ATTEMPTS'
              value: '10'
            }
            {
              name: 'APCL_DEPLOYMENT_POLL_BEARER_TOKEN'
              value: ''
            }
            {
              name: 'APCL_ENFORCE_DEPLOYER_ALLOWLIST'
              value: 'false'
            }
            {
              name: 'APCL_ALLOWED_DEPLOYER_IDENTITIES'
              value: ''
            }
            {
              name: 'APCL_DEPLOYMENT_IDEMPOTENCY_HEADER'
              value: 'idempotency-key'
            }
            {
              name: 'APCL_EASYAUTH_ALLOWED_APP_IDS'
              value: ''
            }
            {
              name: 'APCL_EASYAUTH_ALLOWED_TENANT_IDS'
              value: ''
            }
            {
              name: 'APCL_EASYAUTH_GROUP_ROLE_MAP_JSON'
              value: '{}'
            }
            {
              name: 'APCL_APPROVER_GROUPS_JSON'
              value: '{"manager":[],"procurement":[],"finance":[],"platform":[]}'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
      volumes: [
        {
          name: 'apcl-state'
          storageType: 'AzureFile'
          storageName: 'apclstate'
        }
      ]
    }
  }
}

resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, containerApp.id, 'apcl-acr-pull')
  scope: containerRegistry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVaultSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, containerApp.id, 'apcl-kv-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output containerAppResourceId string = containerApp.id
output containerAppNameOut string = containerApp.name
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output keyVaultNameOut string = keyVault.name
output entitlementSecretUri string = entitlementSecret.properties.secretUriWithVersion
output stateStorageAccountOut string = stateStorageAccount.name
output stateFileShareOut string = stateFileShare.name
